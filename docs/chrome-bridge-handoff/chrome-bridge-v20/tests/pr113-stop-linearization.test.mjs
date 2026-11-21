import test from 'node:test';
import assert from 'node:assert/strict';
import {installBackgroundCoordinator} from '../extension/background-coordinator.js';
import {pageAction} from '../extension/page.js';

// Capture the real Node timers before syntheticPage replaces globalThis.setTimeout.
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

function bounded(promise, phase, events, timeoutMs = 2000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = nativeSetTimeout(() => {
      reject(new Error(
        'Timed out waiting for ' + phase + '; trace=' + events.join(' -> ')
      ));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    nativeClearTimeout(timer);
  });
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

  const pageNativeSetTimeout = globalThis.setTimeout;
  let held = false;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 200 && !held) {
      held = true;
      barrierReached.resolve();
      releasePage.promise.then(() => callback(...args));
      return 1;
    }
    // Preserve real timer semantics for the coordinator's bounded drain;
    // only the pageAction Send-readiness wait is held by the deferred barrier.
    return pageNativeSetTimeout(callback, delay, ...args);
  };

  return () => {
    // Keep a reference to the original timer in this fixture so restoration
    // remains independent of the module-level watchdog implementation.
    void pageNativeSetTimeout;
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
  return {chromeApi,listeners,flags};
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
  const overallDeadline = Date.now() + 7000;
  const waitFor = (promise, phase) => bounded(
    promise,
    phase,
    events,
    Math.max(1, Math.min(1500, overallDeadline - Date.now()))
  );

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
    await waitFor(barrierReached.promise, 'pageAction Send-readiness barrier');

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
    await waitFor(stopAckSeen.promise, 'offscreen Stop ACK');
    await waitFor(new Promise(resolve => setImmediate(resolve)), 'event-loop settle');
    const stopRespondedWhilePageHeld = stopResult !== undefined;

    // Release the actual pageAction so a coordinator-owned drain can settle.
    releasePage.resolve();
    const [dispatchResult,finalStopResult] = await waitFor(
      Promise.all([dispatchCompleted, stopCompleted]),
      'dispatch and Stop completion'
    );
    assert.equal(finalStopResult?.ok,true,
      'a pageAction released within the drain bound must yield a confirmed Stop, not an early UNKNOWN');

    const stopIndex = events.findIndex(event =>
      typeof event === 'string' && event.startsWith('stop-response:'));
    const clickIndex = events.indexOf('page-click');
    assert.ok(stopIndex >= 0, 'Stop handler did not return a response');
    assert.ok(clickIndex >= 0 || dispatchResult?.error,
      'pageAction neither clicked nor returned a fail-closed error');
    if (clickIndex === -1) {
      assert.match(String(dispatchResult?.error || ''), /STOP|CONTROL|CANCEL|DISCONNECT|REVOKE/i,
        'a no-click outcome must be attributable to fail-closed Stop/Control cancellation');
    }

    // Forward gate: a successful Stop must wait until the accepted page action
    // is settled, and any click must precede the successful Stop response.
    // A failed Stop is not a loophole: it must use the canonical unconfirmed
    // result and explicitly classify the side-effect outcome.
    if (finalStopResult?.ok === true) {
      assert.equal(stopRespondedWhilePageHeld, false,
        'STOP LINEARIZATION VIOLATED: Stop reported success while an accepted pageAction was still held. ' +
        'trace=' + events.join(' -> '));
      assert.ok(clickIndex === -1 || clickIndex < stopIndex,
        'STOP LINEARIZATION VIOLATED: successful Stop preceded a later page click. ' +
        'trace=' + events.join(' -> '));
    } else {
      assert.equal(finalStopResult?.ok, false,
        'Stop must return an explicit success or failure result');
      assert.equal(finalStopResult?.reason, 'BACKGROUND_STOP_UNCONFIRMED',
        'a failed Stop must use the canonical unconfirmed reason; arbitrary {ok:false} is not a safe outcome');
      if (clickIndex > stopIndex) {
        assert.equal(finalStopResult?.outcome, 'UNKNOWN',
          'a page click after an unconfirmed Stop response must remain UNKNOWN; never retry automatically');
      } else if (clickIndex === -1) {
        assert.equal(finalStopResult?.outcome, 'NOT_PERFORMED',
          'a no-click fail-closed result must explicitly report NOT_PERFORMED');
      } else {
        assert.equal(finalStopResult?.outcome, 'UNKNOWN',
          'a click before Stop still requires an explicit side-effect outcome');
      }
    }
  } finally {
    releasePage.resolve();
    // Always release the held page action and give accepted dispatch/Stop
    // callbacks a bounded cleanup window before restoring global descriptors.
    try {
      await bounded(
        Promise.allSettled([dispatchCompleted, stopCompleted]),
        'cleanup drain',
        events,
        1000
      );
    } catch (error) {
      events.push('cleanup-timeout:' + error.message);
    }
    restorePage();
  }
});

test('harness watchdog bounds a missing barrier and restores synthetic globals', async () => {
  const names = ['HTMLTextAreaElement','document','location','setTimeout'];
  const before = new Map(names.map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const events = [];
  const barrierReached = deferred();
  const releasePage = deferred();
  const restorePage = syntheticPage(events, barrierReached, releasePage);

  try {
    await assert.rejects(
      bounded(barrierReached.promise, 'synthetic missing pageAction barrier', events, 25),
      /Timed out waiting for synthetic missing pageAction barrier/
    );
  } finally {
    releasePage.resolve();
    restorePage();
  }

  for (const name of names) {
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(globalThis,name),
      before.get(name),
      'global descriptor was not restored for ' + name
    );
  }
});


test('Stop timeout returns UNKNOWN, quarantines the tab, and fences new mutations', async () => {
  const events = [];
  const barrierReached = deferred();
  const releasePage = deferred();
  const stopAckSeen = deferred();
  const restorePage = syntheticPage(events, barrierReached, releasePage);
  const {chromeApi,listeners,flags} = syntheticChrome(events, stopAckSeen);
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
    name:'agent_send',
    expires:Date.now()+60_000,
    args:{
      tabId:17,
      text:'Synthetic timeout regression fixture; never sent to a provider',
      expectedOrigin:'https://claude.ai',
      expectedConversationId:'abcdefgh12345678'
    }
  };

  let dispatchReply;
  const dispatchCompleted = new Promise(resolve => { dispatchReply = resolve; });
  let stopResult;
  let stopReply;
  const stopCompleted = new Promise(resolve => { stopReply = resolve; });

  try {
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response => dispatchReply(response)),true);
    await bounded(barrierReached.promise,'held pageAction barrier',events,1500);

    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'stop-background'
    },control,response => {
      stopResult = response;
      events.push('stop-response:' + JSON.stringify(response));
      stopReply(response);
    }),true);
    await bounded(stopAckSeen.promise,'offscreen Stop ACK',events,1500);

    let secondDispatch;
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response => { secondDispatch = response; }),false);
    assert.equal(secondDispatch?.error,'BACKGROUND_STOP_IN_PROGRESS',
      'Stop must synchronously reject new mutations after fencing admission');

    await bounded(stopCompleted,'bounded Stop timeout',events,6500);
    assert.equal(stopResult?.ok,false);
    assert.equal(stopResult?.reason,'BACKGROUND_STOP_UNCONFIRMED');
    assert.equal(stopResult?.outcome,'UNKNOWN');
    assert.deepEqual(flags.bridgeMutationQuarantinedTabs,[17]);
    assert.equal(events.includes('page-click'),false,
      'the held page action must not have clicked before the timeout response');

    const stopIndex = events.findIndex(event =>
      typeof event === 'string' && event.startsWith('stop-response:'));
    releasePage.resolve();
    await bounded(dispatchCompleted,'late pageAction settlement',events,1500);
    const clickIndex = events.indexOf('page-click');
    assert.ok(clickIndex > stopIndex,
      'late click after unconfirmed Stop is allowed only as UNKNOWN and must remain quarantined');
  } finally {
    releasePage.resolve();
    try {
      await bounded(Promise.allSettled([dispatchCompleted,stopCompleted]),
        'timeout test cleanup',events,1500);
    } catch {}
    restorePage();
  }
});
