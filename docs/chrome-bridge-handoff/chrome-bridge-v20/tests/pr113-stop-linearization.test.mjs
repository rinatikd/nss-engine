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
        // First readiness poll sees no button and enters pageAction's real
        // 200ms await. After release, the next poll sees the enabled button.
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
    // Other pageAction waits are completed deterministically. The only held
    // await is its final Send-button readiness poll.
    queueMicrotask(() => callback(...args));
    return 1;
  };

  return () => {
    globalThis.setTimeout = nativeSetTimeout;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.HTMLTextAreaElement;
  };
}

function syntheticChrome(events) {
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
        // Execute the actual imported pageAction function. Do not substitute
        // a guessed result or a fake page-action promise.
        assert.equal(func, pageAction);
        const result = await func(...args);
        return [{result}];
      }
    }
  };
  return {chromeApi,listeners,flags,tab};
}

test('PR113 all-tabs Stop must not acknowledge while an injected pageAction can still click', async () => {
  const events = [];
  const barrierReached = deferred();
  const releasePage = deferred();
  const restorePage = syntheticPage(events, barrierReached, releasePage);
  const {chromeApi,listeners} = syntheticChrome(events);
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
  try {
    events.push('dispatch-accepted');
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response => {
      events.push('dispatch-response');
      dispatchReply(response);
    }),true);

    // This resolves only from the real pageAction's awaited Send readiness
    // loop, immediately before it resumes into the synchronous control(),
    // conversation checks and btn.click() sequence.
    await barrierReached.promise;

    let stopReply;
    const stopCompleted = new Promise(resolve => { stopReply = resolve; });
    events.push('stop-request');
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'stop-background'
    },control,response => {
      events.push('stop-response:' + JSON.stringify(response));
      stopReply(response);
    }),true);

    const stopResult = await stopCompleted;
    assert.deepEqual(stopResult,{ok:true});
    assert.ok(events.includes('offscreen-stop-ack'));
    assert.equal(events.includes('page-click'),false,
      'page action must still be held when Stop responds');

    // Resume the actual imported pageAction. Its final Control check only
    // sees the captured expiry/origin, so current source can still click.
    releasePage.resolve();
    const dispatchResult = await dispatchCompleted;
    assert.equal(dispatchResult.result.sent,true);

    const stopIndex = events.indexOf('stop-response:{"ok":true}');
    const clickIndex = events.indexOf('page-click');
    assert.ok(stopIndex >= 0 && clickIndex > stopIndex,
      'expected the current-source race to be visible in the event trace');
    assert.ok(clickIndex < stopIndex,
      'STOP LINEARIZATION VIOLATED: a synthetic Send click occurred after Stop reported success. Trace: ' +
      events.join(' -> '));
  } finally {
    releasePage.resolve();
    restorePage();
  }
});
