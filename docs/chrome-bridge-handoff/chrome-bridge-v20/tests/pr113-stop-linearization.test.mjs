import test from 'node:test';
import assert from 'node:assert/strict';
import {installBackgroundCoordinator} from '../extension/background-coordinator.js';
import {pageAction} from '../extension/page.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

function syntheticPage(events, barrierReached, releasePage) {
  let value = '';
  let sendQueries = 0;
  let clicked = false;
  const names = ['HTMLTextAreaElement','document','location','setTimeout'];
  const previous = new Map(names.map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));

  class FakeTextArea {
    constructor() {
      this.tagName = 'TEXTAREA';
      this.type = '';
      this.name = '';
      this.id = 'composer';
      this.autocomplete = '';
      this.disabled = false;
    }
    get value() { return value; }
    set value(next) { value = String(next); }
    getClientRects() { return [{}]; }
    getAttribute() { return null; }
    focus() {}
    dispatchEvent() { return true; }
  }

  const composer = new FakeTextArea();
  const button = {
    tagName: 'BUTTON',
    type: 'button',
    name: '',
    id: 'send',
    disabled: false,
    getClientRects: () => [{}],
    getAttribute: () => null,
    click: () => {
      clicked = true;
      events.push('page-click');
    }
  };
  const stopButton = {
    tagName: 'BUTTON',
    getClientRects: () => [{}],
    getAttribute: () => null
  };

  globalThis.HTMLTextAreaElement = FakeTextArea;
  globalThis.document = {
    readyState: 'complete',
    querySelectorAll(selector) {
      if (selector === '#composer') return [composer];
      if (selector === '#send') {
        sendQueries += 1;
        // The first Send readiness poll enters pageAction's real 200ms await.
        return sendQueries === 1 ? [] : [button];
      }
      if (selector === '#stop') return clicked ? [stopButton] : [];
      if (selector === '#reply') return [];
      return [];
    }
  };
  globalThis.location = {
    origin: 'https://claude.ai',
    pathname: '/chat/abcdefgh12345678',
    search: '',
    hash: '',
    href: 'https://claude.ai/chat/abcdefgh12345678'
  };

  const nativeSetTimeout = globalThis.setTimeout;
  let held = false;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 200 && !held) {
      held = true;
      barrierReached.resolve();
      releasePage.promise.then(() => callback(...args));
      return 1;
    }
    // Keep all other pageAction waits deterministic; only the real Send
    // readiness await is held by the deferred barrier.
    queueMicrotask(() => callback(...args));
    return 1;
  };

  return () => {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
  };
}

function syntheticChrome(events, stopAckSeen) {
  const flags = {
    bridgeBackgroundMode: true,
    bridgeMutationLabMode: true,
    bridgeConnectionDesired: true,
    bridgeAllTabsMode: true,
    adapters: JSON.stringify({
      claude: {composer:'#composer',send:'#send',stop:'#stop',reply:'#reply'}
    })
  };
  const listeners = [];
  const tab = {
    id: 17,
    url: 'https://claude.ai/chat/abcdefgh12345678',
    title: 'Synthetic Claude fixture',
    active: true,
    windowId: 1
  };
  const chromeApi = {
    runtime: {
      id: 'synthetic-extension-id',
      getURL: path => 'chrome-extension://synthetic-extension-id/' + path,
      onMessage: {addListener: listener => listeners.push(listener)},
      getContexts: async () => [],
      sendMessage: async message => {
        events.push('offscreen-' + message.type + '-ack');
        if (message.type === 'stop') stopAckSeen.resolve();
        return {ok:true};
      }
    },
    storage: {
      local: {
        get: async keys => {
          if (Array.isArray(keys))
            return Object.fromEntries(keys.map(key => [key, flags[key]]));
          if (typeof keys === 'string') return {[keys]:flags[keys]};
          return {...flags};
        },
        set: async next => {
          Object.assign(flags, next);
          events.push('persist-stop-intent');
        }
      },
      session: {
        setAccessLevel: async () => {},
        remove: async () => {}
      }
    },
    permissions: {
      contains: async () => true
    },
    tabs: {
      get: async id => {
        assert.equal(id, tab.id);
        return {...tab};
      }
    },
    scripting: {
      executeScript: async ({func,args}) => {
        // Execute the actual imported pageAction, not a guessed result.
        assert.equal(func, pageAction);
        const result = await func(...args);
        return [{result}];
      }
    }
  };
  return {chromeApi,listeners};
}

test('PR113 all-tabs Stop never reports success before an accepted pageAction is safe', async () => {
  const events = [];
  const barrierReached = deferred();
  const releasePage = deferred();
  const stopAckSeen = deferred();
  const restorePage = syntheticPage(events, barrierReached, releasePage);
  const {chromeApi,listeners} = syntheticChrome(events, stopAckSeen);
  installBackgroundCoordinator(chromeApi);

  const offscreen = {
    id: chromeApi.runtime.id,
    url: chromeApi.runtime.getURL('transport-host.html')
  };
  const control = {
    id: chromeApi.runtime.id,
    url: chromeApi.runtime.getURL('control.html')
  };
  const command = {
    name: 'agent_send',
    expires: Date.now() + 60_000,
    args: {
      tabId: 17,
      text: 'Synthetic regression fixture; never sent to a provider',
      expectedOrigin: 'https://claude.ai',
      expectedConversationId: 'abcdefgh12345678'
    }
  };

  let dispatchReply;
  const dispatchCompleted = new Promise(resolve => { dispatchReply = resolve; });
  let stopResult;
  let stopReply;
  const stopCompleted = new Promise(resolve => { stopReply = resolve; });

  try {
    events.push('dispatch-accepted');
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response => {
      events.push('dispatch-response');
      dispatchReply(response);
    }),true);

    // Resolved by the real imported pageAction at its final asynchronous
    // Send-button readiness wait, before its synchronous Control/context
    // checks and btn.click().
    await barrierReached.promise;

    events.push('stop-request');
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'stop-background'
    },control,response => {
      stopResult = response;
      events.push('stop-response:' + JSON.stringify(response));
      stopReply(response);
    }),true);

    // Let the current Stop handler finish its offscreen ACK continuation.
    // A correct drain implementation remains pending while pageAction is held.
    await stopAckSeen.promise;
    await new Promise(resolve => setImmediate(resolve));
    const stopRespondedWhilePageHeld = stopResult !== undefined;

    // Release the actual pageAction so a coordinator-owned drain can settle.
    releasePage.resolve();
    const [dispatchResult,finalStopResult] = await Promise.all([
      dispatchCompleted,
      stopCompleted
    ]);

    const stopIndex = events.findIndex(event =>
      typeof event === 'string' && event.startsWith('stop-response:'));
    const clickIndex = events.indexOf('page-click');
    assert.ok(stopIndex >= 0, 'Stop handler did not return a response');
    assert.ok(clickIndex >= 0 || dispatchResult?.error,
      'pageAction neither clicked nor returned a fail-closed error');

    // The only forbidden outcome is a successful Stop response followed by
    // a click from work accepted before Stop. A bounded unconfirmed Stop is
    // not success and must remain distinguishable to the caller.
    assert.ok(finalStopResult.ok !== true || clickIndex === -1 || clickIndex < stopIndex,
      'STOP LINEARIZATION VIOLATED: successful Stop preceded a later page click. ' +
      'stopRespondedWhilePageHeld=' + stopRespondedWhilePageHeld +
      '; trace=' + events.join(' -> '));
  } finally {
    releasePage.resolve();
    restorePage();
  }
});
