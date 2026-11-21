import test from 'node:test';
import assert from 'node:assert/strict';
import {installBackgroundCoordinator,startBackgroundTransport} from '../extension/background-coordinator.js';
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

async function resetSyntheticStopState(chromeApi, flags) {
  flags.bridgeConnectionDesired = true;
  flags.bridgeMutationLabMode = true;
  flags.bridgeAllTabsMode = true;
  await startBackgroundTransport(chromeApi);
}

function syntheticChrome(events, stopAckSeen) {
  const flags = {
    bridgeBackgroundMode: true,
    bridgeMutationLabMode: true,
    bridgeConnectionDesired: true,
    bridgeAllTabsMode: true,
    browserToken: 'synthetic-browser-token',
    adapters: JSON.stringify({
      claude: {composer:'#composer',send:'#send',stop:'#stop',reply:'#reply'}
    })
  };
  const listeners = [];
  const sessionState = {};
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
        },
        setAccessLevel: async () => {}
      },
      session: {
        setAccessLevel: async () => {},
        get: async key => ({[key]:sessionState[key] || {}}),
        set: async next => Object.assign(sessionState,next),
        remove: async key => { delete sessionState[key]; }
      }
    },
    offscreen: {createDocument: async () => {}},
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
  return {chromeApi,listeners,flags,sessionState};
}

test('PR113 all-tabs Stop never reports success before an accepted pageAction is safe', async () => {
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
    await resetSyntheticStopState(chromeApi, flags);
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



test('per-tab Revoke fences new work and waits for accepted pageAction lane', async () => {
  const events = [];
  const barrierReached = deferred();
  const releasePage = deferred();
  const stopAckSeen = deferred();
  const restorePage = syntheticPage(events, barrierReached, releasePage);
  const {chromeApi,listeners,flags} = syntheticChrome(events, stopAckSeen);
  installBackgroundCoordinator(chromeApi);
  const offscreen = {
    id:chromeApi.runtime.id,
    url:chromeApi.runtime.getURL('transport-host.html')
  };
  const control = {
    id:chromeApi.runtime.id,
    url:chromeApi.runtime.getURL('control.html')
  };
  const command = {
    name:'agent_send',
    expires:Date.now()+60_000,
    args:{
      tabId:17,
      text:'Synthetic per-tab Revoke fixture; never sent to a provider',
      expectedOrigin:'https://claude.ai',
      expectedConversationId:'abcdefgh12345678'
    }
  };
  let firstReply, secondReply, revokeReply, lateReply;
  const firstDone=new Promise(resolve=>{firstReply=resolve;});
  const secondDone=new Promise(resolve=>{secondReply=resolve;});
  const revokeDone=new Promise(resolve=>{revokeReply=resolve;});

  try {
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response=>firstReply(response)),true);
    await bounded(barrierReached.promise,'Revoke held pageAction barrier',events,1500);

    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response=>secondReply(response)),true);

    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'revoke-background-control',tabId:17
    },control,response=>{
      events.push('revoke-response');
      revokeReply(response);
    }),true);

    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response=>{lateReply=response;}),false);
    assert.equal(lateReply?.error,'TAB_MUTATION_REVOKING');

    await bounded(new Promise(resolve=>setImmediate(resolve)),
      'Revoke remains pending while accepted lane is held',events,1500);
    assert.equal(events.includes('revoke-response'),false);

    releasePage.resolve();
    const [first,second,revoke]=await bounded(
      Promise.all([firstDone,secondDone,revokeDone]),
      'per-tab Revoke drain',events,2500
    );
    assert.ok(first?.result);
    assert.equal(second?.error,'TAB_MUTATION_REVOKING');
    assert.deepEqual(revoke,{ok:true});
    assert.equal(events.filter(event=>event==='page-click').length,1);
    assert.ok(events.indexOf('page-click')<events.indexOf('revoke-response'));
  } finally {
    releasePage.resolve();
    try {
      await bounded(Promise.allSettled([firstDone,secondDone,revokeDone]),
        'Revoke test cleanup',events,1500);
    } catch {}
    restorePage();
    await resetSyntheticStopState(chromeApi,flags);
  }
});

test('Stop timeout returns UNKNOWN, quarantines the tab, and fences new mutations', async () => {
  const events = [];
  const barrierReached = deferred();
  const releasePage = deferred();
  const stopAckSeen = deferred();
  const restorePage = syntheticPage(events, barrierReached, releasePage);
  const {chromeApi,listeners,flags,sessionState} = syntheticChrome(events, stopAckSeen);
  installBackgroundCoordinator(chromeApi);
  const originalLocalSet=chromeApi.storage.local.set.bind(chromeApi.storage.local);
  chromeApi.storage.local.set=async next=>{
    if(Object.hasOwn(next,'bridgeMutationQuarantinedTabs'))
      throw Error('SYNTHETIC_LOCAL_QUARANTINE_WRITE_FAILURE');
    return originalLocalSet(next);
  };

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

    // A concurrent Connect/start must not clear the Stop admission fence.
    flags.bridgeConnectionDesired = true;
    let concurrentStart;
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'start-background'
    },control,response => { concurrentStart = response; }),true);
    await bounded(new Promise(resolve => setImmediate(resolve)),
      'concurrent start rejection',events,1500);
    assert.equal(concurrentStart?.ok,false);
    assert.equal(concurrentStart?.reason,'BACKGROUND_STOP_IN_PROGRESS');

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
    assert.deepEqual(sessionState.bridgeMutationQuarantinedTabs,[17],
      'when local quarantine persistence fails, the session fallback must preserve the tab fence');
    assert.equal(events.includes('page-click'),false,
      'the held page action must not have clicked before the timeout response');

    const stopIndex = events.findIndex(event =>
      typeof event === 'string' && event.startsWith('stop-response:'));
    releasePage.resolve();
    await bounded(dispatchCompleted,'late pageAction settlement',events,1500);
    const clickIndex = events.indexOf('page-click');
    assert.ok(clickIndex > stopIndex,
      'late click after unconfirmed Stop is allowed only as UNKNOWN and must remain quarantined');

    // A fresh worker instance must recover the quarantine from storage.session,
    // even though its module-level in-memory Set starts empty.
    const restartedApi = await import('../extension/background-coordinator.js?worker-restart-quarantine');
    const restarted = syntheticChrome(events, deferred());
    restarted.sessionState.bridgeMutationQuarantinedTabs = [17];
    restartedApi.installBackgroundCoordinator(restarted.chromeApi);
    let restartedReply;
    const restartedAccepted = restarted.listeners[0]({
      target:'bridge-coordinator',type:'dispatch',command
    },offscreen,response=>{restartedReply=response;});
    assert.equal(restartedAccepted,true);
    await bounded(new Promise(resolve=>setImmediate(resolve)),
      'restarted worker quarantine lookup',events,1500);
    assert.equal(restartedReply?.error,'TAB_MUTATION_QUARANTINED',
      'worker restart must read the session-persisted quarantine before page mutation');
  } finally {
    releasePage.resolve();
    try {
      await bounded(Promise.allSettled([dispatchCompleted,stopCompleted]),
        'timeout test cleanup',events,1500);
    } catch {}
    restorePage();
    await resetSyntheticStopState(chromeApi, flags);
  }
});


test('Grant accepted before Revoke drains first; late concurrent Grant cannot restore the grant', async () => {
  const events=[];
  const stopAckSeen=deferred();
  const {chromeApi,listeners,sessionState}=syntheticChrome(events,stopAckSeen);
  installBackgroundCoordinator(chromeApi);
  const control={id:chromeApi.runtime.id,url:chromeApi.runtime.getURL('control.html')};
  const grantReadStarted=deferred();
  const releaseGrantRead=deferred();
  const originalGet=chromeApi.storage.session.get.bind(chromeApi.storage.session);
  let held=false;
  chromeApi.storage.session.get=async key=>{
    if(key==='bridgeBackgroundControlGrants' && !held){
      held=true;
      grantReadStarted.resolve();
      await releaseGrantRead.promise;
    }
    return originalGet(key);
  };

  let grantReply,revokeReply,lateGrantReply;
  const grantDone=new Promise(resolve=>{grantReply=resolve;});
  const revokeDone=new Promise(resolve=>{revokeReply=resolve;});
  try{
    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'grant-background-control',
      tabId:17,durationMinutes:15,localGesture:true
    },control,response=>grantReply(response)),true);
    await bounded(grantReadStarted.promise,'Grant storage read barrier',events,1500);

    assert.equal(listeners[0]({
      target:'bridge-coordinator',type:'revoke-background-control',tabId:17
    },control,response=>revokeReply(response)),true);

    // This Grant arrives after Revoke fenced the tab and must be rejected
    // synchronously rather than queued behind the Revoke.
    const lateAccepted=listeners[0]({
      target:'bridge-coordinator',type:'grant-background-control',
      tabId:17,durationMinutes:15,localGesture:true
    },control,response=>{lateGrantReply=response;});
    assert.equal(lateAccepted,false);
    assert.equal(lateGrantReply?.error,'TAB_CONTROL_REVOKING');

    await bounded(new Promise(resolve=>setImmediate(resolve)),
      'Revoke waits for accepted Grant',events,1500);
    assert.equal(revokeDone instanceof Promise,true);
    releaseGrantRead.resolve();
    const [grant,revoke]=await bounded(Promise.all([grantDone,revokeDone]),
      'Grant then Revoke serialization',events,1500);
    assert.equal(grant?.origin,'https://claude.ai');
    assert.deepEqual(revoke,{ok:true});
    assert.equal(sessionState.bridgeBackgroundControlGrants?.['17'],undefined,
      'successful Revoke must be the final writer for this tab grant');
  }finally{
    releaseGrantRead.resolve();
  }
});
