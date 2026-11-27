// Функция, которая целиком сериализуется и выполняется Р’РќРЈРўР И страницы (chrome.scripting.executeScript).
// Она не должна ссылаться ни на что снаружи. Возвращает данные или {error}.
export async function pageAction(name, args, expectedOrigin) {
  const failureStartedAt=Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (e) => !!e && e.getClientRects().length > 0;
  const qa = (s) => { try { return s ? [...document.querySelectorAll(s)] : []; } catch { return []; } };
  const one = (s) => qa(s).find(vis);
  let releaseActionLock = () => {};
  let providerPrepareMutationStarted = false;
  let providerCommitClickStarted = false;
  let providerCommitClickReturned = false;
  let mutationSideEffectStarted = false;
  let agentSendDraftMutationStarted = false;
  let trackedOperation = null;
  const operationRegistryKey = '__chromeBridgeOperationRegistry';
  const trackedMutationNames = new Set([
    'browser_click','browser_fill','agent_send','provider_prepare','provider_commit'
  ]);
  const markOperationSideEffectStarted = () => {
    if (trackedOperation) trackedOperation.sideEffectStarted = true;
  };
  const checkOperationCancelled = () => {
    if (trackedOperation?.cancelRequested && !trackedOperation.sideEffectStarted) {
      const error = Error('MUTATION_CANCELLED_BEFORE_SIDE_EFFECT');
      error.dispatchState = 'NOT_PERFORMED';
      error.sideEffect = 'none';
      throw error;
    }
  };
  const conversationId = () => {
    const routes = {
      'https://claude.ai': /^\/chat\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://gemini.google.com': /^\/app\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://chat.deepseek.com': /^\/a\/chat\/s\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://grok.com': /^\/c\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://chat.qwen.ai': /^\/c\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://www.kimi.ai': /^\/chat\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
    };
    return location.pathname.match(routes[location.origin] || /$a/)?.[1] || null;
  };
  const describe = (e) => ({
    tag: e.tagName.toLowerCase(), type: e.type || '', name: e.name || '', id: e.id || '',
    text: String(e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 120),
    href: e.href || (e.closest && e.closest('a') ? e.closest('a').href : '') || '',
    formAction: (e.form && e.form.action) || '',
  });
  const single = (selector) => {
    const m = document.querySelectorAll(selector);
    if (m.length !== 1) throw Error('Selector must match exactly one element (matched ' + m.length + ')');
    if (!m[0].getClientRects().length || m[0].disabled) throw Error('Element hidden or disabled');
    return m[0];
  };
  const verifyExpect = (e, expect) => {
    if (!expect) return;
    const d = describe(e);
    if (d.tag !== expect.tag || d.text !== expect.text) throw Error('Element changed after approval');
  };
  try {
    const operationIdPattern = /^[A-Za-z0-9_-]{16,100}$/;
    const reserveOperationRegistrySlot = registry => {
      const terminal = Object.values(registry)
        .filter(item=>item && item.state!=='RUNNING' && item.state!=='CANCELLED_BEFORE_START')
        .sort((a,b)=>(a.finishedAt||0)-(b.finishedAt||0));
      while (Object.keys(registry).length>=256 && terminal.length) {
        const oldest=terminal.shift();
        if (oldest) delete registry[oldest.operationId];
      }
      return Object.keys(registry).length<256;
    };
    if (name === 'cancel_operation') {
      if (expectedOrigin !== location.origin) throw Error('TAB_NAVIGATED_DURING_CANCELLATION');
      if (!operationIdPattern.test(args?.operationId || '')) throw Error('MUTATION_OPERATION_ID_INVALID');
      const registry = globalThis[operationRegistryKey] ||
        (globalThis[operationRegistryKey] = Object.create(null));
      let target = registry[args.operationId];
      if (!target) {
        if (!reserveOperationRegistrySlot(registry)) throw Error('MUTATION_OPERATION_REGISTRY_CAPACITY_EXCEEDED');
        // Revoke may win the race after the write-ahead INJECTING event but
        // before Chrome starts the original executeScript. Persist an exact
        // operation tombstone in this document so a late injection cannot run.
        let resolveDone;
        const done = new Promise(resolve=>{resolveDone=resolve;});
        target = {
          operationId:args.operationId,cancelRequested:true,sideEffectStarted:false,
          state:'CANCELLED_BEFORE_START',startedAt:Date.now(),finishedAt:Date.now(),
          done,resolveDone
        };
        registry[args.operationId]=target;
        return {
          operationId:args.operationId,found:true,cancelRequested:true,
          preemptedBeforeStart:true,safeToRelease:true,
          state:'CANCELLED_BEFORE_SIDE_EFFECT',sideEffectStarted:false
        };
      }
      if (target.state==='CANCELLED_BEFORE_START' &&
          target.cancelRequested===true && target.sideEffectStarted!==true) {
        return {
          operationId:args.operationId,found:true,cancelRequested:true,
          preemptedBeforeStart:true,safeToRelease:true,
          state:'CANCELLED_BEFORE_SIDE_EFFECT',sideEffectStarted:false
        };
      }
      if (!target.sideEffectStarted &&
          ['CANCELLED_BEFORE_SIDE_EFFECT','NO_SIDE_EFFECT'].includes(target.state)) {
        return {
          operationId:args.operationId,found:true,cancelRequested:target.cancelRequested===true,
          safeToRelease:true,sideEffectStarted:false,state:target.state
        };
      }
      if (target.sideEffectStarted || target.state !== 'RUNNING') {
        return {
          operationId:args.operationId,found:true,safeToRelease:false,sideEffectStarted:target.sideEffectStarted===true,
          state:target.state||'UNKNOWN'
        };
      }
      target.cancelRequested = true;
      const timeoutMs = Math.max(100,Math.min(5000,Number(args.timeoutMs)||2000));
      const completion = await Promise.race([
        target.done.then(value=>({completed:true,value})),
        sleep(timeoutMs).then(()=>({completed:false}))
      ]);
      return {
        operationId:args.operationId,found:true,cancelRequested:true,
        safeToRelease:completion.completed &&
          completion.value?.state==='CANCELLED_BEFORE_SIDE_EFFECT' &&
          completion.value?.sideEffectStarted===false,
        state:completion.completed?completion.value?.state:'CANCEL_ACK_TIMEOUT',
        sideEffectStarted:completion.completed
          ? completion.value?.sideEffectStarted===true : target.sideEffectStarted===true
      };
    }
    if (trackedMutationNames.has(name)) {
      if (!operationIdPattern.test(args?.operationId || '')) throw Error('MUTATION_OPERATION_ID_REQUIRED');
      const registry = globalThis[operationRegistryKey] ||
        (globalThis[operationRegistryKey] = Object.create(null));
      const existing = registry[args.operationId];
      if (existing?.state === 'CANCELLED_BEFORE_START' &&
          existing.cancelRequested===true && existing.sideEffectStarted!==true) {
        trackedOperation=existing;
        throw Error('MUTATION_CANCELLED_BEFORE_SIDE_EFFECT');
      }
      if (existing) throw Error(
        existing.state==='RUNNING'?'MUTATION_OPERATION_ALREADY_RUNNING':'MUTATION_OPERATION_ALREADY_SEEN'
      );
      if (!reserveOperationRegistrySlot(registry))
        throw Error('MUTATION_OPERATION_REGISTRY_CAPACITY_EXCEEDED');
      let resolveDone;
      const done = new Promise(resolve=>{resolveDone=resolve;});
      trackedOperation = {
        operationId:args.operationId,cancelRequested:false,sideEffectStarted:false,
        state:'RUNNING',startedAt:Date.now(),done,resolveDone
      };
      registry[args.operationId] = trackedOperation;
      // Yield once before any page mutation so a concurrent Revoke can set the
      // cancellation bit in this exact document's isolated-world registry.
      await sleep(0);
      checkOperationCancelled();
    }
    const control = () => {
      if (!['https://claude.ai', 'https://gemini.google.com', 'https://chat.deepseek.com', 'https://grok.com', 'https://chat.qwen.ai', 'https://www.kimi.ai'].includes(location.origin) ||
          location.origin !== expectedOrigin || !(args.controlExpires > Date.now())) throw Error('Control denied: local re-grant required');
    };
    if (['browser_click', 'browser_fill', 'agent_send', 'provider_prepare', 'provider_commit'].includes(name)) control();
    if (location.origin !== expectedOrigin) throw Error('Tab navigated to another origin');
    if (['browser_click','browser_fill','agent_send','provider_prepare','provider_commit'].includes(name)) {
      const key='__chromeBridgeMutationLock';
      if (window[key]) throw Error('TAB_MUTATION_BUSY');
      const lock={
        requestId:typeof args.requestId==='string'?args.requestId:'local-'+Date.now(),
        name,startedAt:Date.now(),origin:location.origin,conversationId:conversationId()
      };
      window[key]=lock;
      releaseActionLock=()=>{
        if (name==='provider_prepare' || name==='provider_commit') {
          // A terminal record exists only after this exact isolated-world
          // execution reaches finally. A worker restart or missing lock alone
          // is never treated as proof that the page action ended.
          window.__chromeBridgeMutationTerminal={
            schemaVersion:1,requestId:lock.requestId,command:name,
            origin:lock.origin,conversationId:lock.conversationId,
            startedAt:lock.startedAt,completedAt:Date.now(),
            state:name==='provider_commit'
              ? (providerCommitClickStarted?'COMMIT_CLICK_ATTEMPTED':'COMMIT_NOT_CLICKED')
              : (providerPrepareMutationStarted?'PREPARE_MUTATION_FINISHED':'PREPARE_NO_MUTATION'),
            clickAttempted:providerCommitClickStarted,
            clickReturned:providerCommitClickReturned,
            payloadHash:typeof args.payloadHash==='string'?args.payloadHash:null,
            preparedId:typeof args.preparedId==='string'?args.preparedId:null
          };
        }
        if(window[key]===lock)delete window[key];
      };
    }

    if (name === 'exists') return { found: !!one(args.selector), loaded: document.readyState === 'complete' };

    if (name === 'agent_context') return { verified: !!conversationId(), origin: location.origin, conversationId: conversationId() };

    if (name === 'describe') { const e = single(args.selector); if (e.closest('input[type=password], input[type=file], [autocomplete=current-password], [autocomplete=one-time-code], [data-sensitive]')) throw Error('Sensitive field inspection blocked'); return describe(e); }

    if (name === 'browser_read') {
      const root = args.selector ? single(args.selector) : document.body;
      const max = args.maxChars || 50000;
      const blocked = 'input, textarea, script, style, [autocomplete], [data-sensitive]';
      if (root.matches(blocked)) throw Error('Sensitive field read blocked');
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const parts = [];
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (parent && vis(parent) && !parent.closest(blocked)) parts.push(walker.currentNode.textContent);
      }
      const full = parts.join(' ');
      return {
        url: location.href, title: document.title, text: full.slice(0, max), truncated: full.length > max,
        links: [...root.querySelectorAll('a[href]')].filter((a) => a.getClientRects().length).slice(0, 150).map((a) => ({ text: a.innerText.slice(0, 200), url: a.href })),
      };
    }

    if (name === 'browser_click') {
      const e = single(args.selector);
      verifyExpect(e, args.expect);
      if (e.closest('input[type=file],input[type=password]')) throw Error('Sensitive input blocked');
      checkOperationCancelled();
      markOperationSideEffectStarted();
      mutationSideEffectStarted = true;
      e.click();
      return { clicked: true };
    }

    if (name === 'browser_fill') {
      const e = single(args.selector);
      verifyExpect(e, args.expect);
      if (typeof args.text !== 'string' || args.text.length > 10000) throw Error('INVALID_FILL_TEXT');
      if (e.closest('input[type=password],input[type=file],[autocomplete=current-password],[autocomplete=one-time-code],[data-sensitive]')) throw Error('Sensitive input blocked');
      if (e.getAttribute('aria-disabled') === 'true' || e.getAttribute('contenteditable') === 'false') throw Error('Input disabled');
      const isTA = e instanceof HTMLTextAreaElement;
      const isInput = e instanceof HTMLInputElement;
      const isEditable = e.isContentEditable === true || e.getAttribute('contenteditable') === 'true';
      if (!isTA && !isInput && !isEditable) throw Error('Expected text input, textarea or contenteditable');
      if (isInput && !['text', 'search', 'email', 'url', 'tel'].includes(e.type)) throw Error('Sensitive or unsupported input type');
      if (/password|passwd|secret|token|credit|cardnumber|cc-number|one-time-code|cvv|cvc/i.test([e.name, e.id, e.autocomplete].join(' '))) throw Error('Sensitive field blocked');
      checkOperationCancelled();
      markOperationSideEffectStarted();
      mutationSideEffectStarted = true;
      e.focus();
      if (isEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(e);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand('delete');
        const inserted = document.execCommand('insertText', false, args.text);
        if (!inserted && args.text.length) throw Error('CONTENTEDITABLE_INSERT_UNSUPPORTED');
        e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: args.text }));
      } else {
        const proto = isTA ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, args.text);
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }
      e.dispatchEvent(new Event('change', { bubbles: true }));
      const actual = isEditable ? String(e.innerText || e.textContent || '') : e.value;
      if (actual.trim() !== args.text.trim()) throw Error('FILL_TEXT_MISMATCH');
      return { filled: true, elementType: isEditable ? 'contenteditable' : isTA ? 'textarea' : 'input', verified: true };
    }

    // ---------- агентские чаты (адаптер приходит в args.adapter) ----------
    const A = args.adapter;
    const composerEl = () => one(A.composer);
    const textOf = (c) => ((c instanceof HTMLTextAreaElement || c instanceof HTMLInputElement) ? c.value : c.innerText || '').trim();
    const replies = () => qa(A.reply).filter(vis).filter(e => !qa(A.reply).some(other => other !== e && other.contains(e)));

    if (name === 'agent_selftest') {
      const r = {};
      for (const k of ['composer', 'send', 'stop', 'reply']) { const all = qa(A[k]); r[k] = { selector: A[k], matched: all.length, visible: all.filter(vis).length }; }
      r.url = location.href;
      // Metadata only: never return page text, input values, or conversation content.
      r.diagnostics = {
        readyState: document.readyState,
        bodyPresent: !!document.body,
        iframeCount: document.querySelectorAll('iframe').length,
        composerCandidates: qa('textarea, [contenteditable="true"], [role="textbox"]').length,
        buttonCandidates: qa('button, [role="button"]').length,
      };
      // V03 selector census: capped, metadata-only, no content/values/labels/URLs.
      const brief = (el) => {
        const plain = (v) => /^[a-z0-9_-]{1,64}$/i.test(v || '') ? v : null;
        const dataTest = plain(el.getAttribute('data-testid'));
        const role = plain(el.getAttribute('role'));
        const ident = plain(el.id);
        const cls = [...el.classList].filter(c => /^[a-z][a-z0-9_-]{1,48}$/i.test(c)).slice(0, 3);
        return { tag: el.tagName.toLowerCase(), role, id: ident, testid: dataTest,
          classes: cls, visible: vis(el), enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
          contenteditable: el.isContentEditable };
      };
      const inputs = qa('textarea, [contenteditable="true"], [role="textbox"]')
        .filter(e => !e.closest('[data-sensitive],input[type="password"]')).slice(0, 8);
      r.diagnostics.inputMetadata = inputs.map(brief);
      let box = inputs.find(vis)?.parentElement;
      for (let hops = 0; box && hops < 6 && !box.querySelector('button,[role="button"]'); hops++) box = box.parentElement;
      r.diagnostics.nearInputButtons = box ? [...box.querySelectorAll('button,[role="button"]')].slice(0, 18).map(brief) : [];
      // Read-only send-button census. No button text, labels, prompt content or URLs
      // are returned. This helps calibrate Gemini after an asynchronous button mount.
      const sendPatterns = {
        dataTestId: 'button[data-testid="chat-input-send"]',
        sendClass: 'button.send-button, .send-button-container button',
        sendAria: 'button[aria-label="Send"], button[aria-label="Send message"], button[aria-label="Отправить"]',
        sendTooltip: 'button[mattooltip="Send"], button[mattooltip="Send message"], button[mattooltip="Отправить"]',
        customButton: '[role="button"][class*="send" i]',
      };
      r.diagnostics.sendCandidates = Object.fromEntries(
        Object.entries(sendPatterns).map(([key, selector]) => {
          const nodes = qa(selector).slice(0, 8);
          return [key, { matched: nodes.length, visible: nodes.filter(vis).length, elements: nodes.slice(0, 3).map(brief) }];
        })
      );
      return r;
    }

    if (name === 'agent_peek') {
      const list = replies();
      const last = list[list.length - 1];
      return {
        count: list.length, text: last ? String(last.innerText || '').trim().slice(0, 100000) : '',
        generating: qa(A.stop).some(vis), composerFound: !!composerEl(), url: location.href,
      };
    }

    // Read-only snapshot used only after the matching provider_commit receipt.
    // The server persists a digest and identity, never the provider's reply text.
    if (name === 'provider_reply_peek') {
      if (args.expectedOrigin !== location.origin || !conversationId() ||
          args.expectedConversationId !== conversationId()) throw Error('PROVIDER_CONVERSATION_CHANGED');
      const list = replies();
      const last = list[list.length - 1];
      const text = last ? String(last.innerText || '').trim().slice(0, 100000) : '';
      return {
        count:list.length, replyIndex:list.length, text, chars:text.length,
        generating:qa(A.stop).some(vis), origin:location.origin,
        conversationId:conversationId(), url:location.href
      };
    }

    if (name === 'provider_prepare') {
      if (args.expectedOrigin !== location.origin || !conversationId() ||
          args.expectedConversationId !== conversationId()) throw Error('PROVIDER_CONVERSATION_CHANGED');
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId || '') || !Number.isSafeInteger(args.epoch) || args.epoch < 1 ||
          typeof args.message !== 'string' || !args.message.trim() || args.message.length > 100000 ||
          !/^[a-f0-9]{64}$/.test(args.payloadHash || '') ||
          !/^[A-Za-z0-9_-]{8,100}$/.test(args.preparedId || '') ||
          !Number.isFinite(Date.parse(args.expiresAt || '')) || Date.parse(args.expiresAt) <= Date.now()) {
        throw Error('PROVIDER_PREPARE_INPUT_INVALID');
      }
      // A calibrated Send target must be identifiable before touching the
      // composer. Do not require it to be enabled yet: many chat providers
      // disable Send while the composer is empty and enable it after input.
      const sendSelector = typeof A.send === 'string' ? A.send.trim() : '';
      if (!sendSelector) throw Error('PROVIDER_SEND_SELECTOR_UNCALIBRATED');
      const initialSendButtons = qa(sendSelector).filter(vis);
      if (initialSendButtons.length !== 1) throw Error('PROVIDER_SEND_SELECTOR_NOT_UNIQUE');
      const initialSend = initialSendButtons[0];
      if (initialSend.tagName.toLowerCase() !== 'button' &&
          initialSend.getAttribute('role') !== 'button') {
        throw Error('PROVIDER_SEND_SELECTOR_NOT_ACTIONABLE');
      }
      const composer = single(A.composer);
      if (!(composer instanceof HTMLTextAreaElement) && !composer.isContentEditable) throw Error('Unsupported composer');
      if (/password|secret|token|credential/i.test([composer.id, composer.name, composer.autocomplete].join(' '))) throw Error('Sensitive composer blocked');
      if (textOf(composer)) throw Error('Existing draft: refusing to overwrite');
      if (qa(A.stop).some(vis)) throw Error('Agent is still generating');
      const baseline = replies().length;
      checkOperationCancelled();
      markOperationSideEffectStarted();
      composer.focus();
      providerPrepareMutationStarted = true;
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(composer, args.message);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', args.message);
          composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch { /* fall back to insertText */ }
        await sleep(150);
        if (!textOf(composer)) document.execCommand('insertText', false, args.message);
      }
      await sleep(300);
      if (textOf(composer) !== args.message.trim()) throw Error('PROVIDER_PREPARE_TEXT_MISMATCH');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(textOf(composer)));
      const actualHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
      if (actualHash !== args.payloadHash) throw Error('PROVIDER_PREPARE_HASH_MISMATCH');

      // Revalidate readiness after input. If the provider did not activate a
      // unique Send button, clear only the exact draft we just inserted and
      // verify the cleanup. Never click Send from the prepare stage.
      const readySendButtons = qa(sendSelector).filter(vis);
      if (readySendButtons.length !== 1 || readySendButtons[0].disabled ||
          readySendButtons[0].getAttribute('aria-disabled') === 'true') {
        let cleared = false;
        if (textOf(composer) === args.message.trim()) {
          if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
            const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(composer, '');
          } else {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(composer);
            selection.removeAllRanges();
            selection.addRange(range);
            document.execCommand('delete');
          }
          composer.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'deleteContentBackward', data: null
          }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));
          cleared = textOf(composer) === '';
        }
        return {
          error: cleared ? 'PROVIDER_SEND_BUTTON_NOT_READY' : 'PROVIDER_PREPARE_ROLLBACK_UNVERIFIED',
          dispatchState: 'NOT_PERFORMED',
          sideEffect: cleared ? 'composer-cleared' : 'composer-draft-may-remain'
        };
      }
      control();
      if (args.expectedOrigin !== location.origin || args.expectedConversationId !== conversationId()) {
        throw Error('PROVIDER_CONVERSATION_CHANGED_BEFORE_PREPARE');
      }
      window.__chromeBridgePreparedDraft = {
        requestId:args.requestId,preparedId:args.preparedId,payloadHash:actualHash,
        origin:location.origin,conversationId:args.expectedConversationId,epoch:args.epoch,expiresAt:args.expiresAt
      };
      return { prepared:true, requestId:args.requestId, preparedId:args.preparedId, expiresAt:args.expiresAt,
        payloadHash:actualHash, sideEffect:'composer-filled-no-send', clickedSend:false, baseline };
    }

    if (name === 'provider_commit') {
      if (args.expectedOrigin !== location.origin || !conversationId() ||
          args.expectedConversationId !== conversationId()) throw Error('PROVIDER_CONVERSATION_CHANGED');
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(args.requestId || '') ||
          !Number.isSafeInteger(args.epoch) || args.epoch < 1 ||
          !/^[A-Za-z0-9_-]{8,100}$/.test(args.preparedId || '') ||
          !/^[a-f0-9]{64}$/.test(args.fencingToken || '') ||
          !/^[a-f0-9]{64}$/.test(args.payloadHash || '')) throw Error('PROVIDER_COMMIT_INPUT_INVALID');
      const prepared = window.__chromeBridgePreparedDraft;
      if (!prepared || prepared.requestId !== args.requestId || prepared.preparedId !== args.preparedId ||
          prepared.payloadHash !== args.payloadHash || prepared.origin !== location.origin ||
          prepared.conversationId !== args.expectedConversationId || prepared.epoch !== args.epoch ||
          Date.parse(prepared.expiresAt) <= Date.now()) throw Error('PROVIDER_PREPARED_BINDING_MISMATCH');
      const composer = single(A.composer);
      if (!(composer instanceof HTMLTextAreaElement) && !composer.isContentEditable) throw Error('Unsupported composer');
      if (textOf(composer).length === 0) throw Error('PROVIDER_PREPARED_DRAFT_MISSING');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(textOf(composer)));
      const actualHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
      if (actualHash !== args.payloadHash) throw Error('PROVIDER_PREPARED_DRAFT_MISMATCH');
      if (qa(A.stop).some(vis)) throw Error('Agent is still generating');
      const baseline = replies().length;
      const sendButtons = qa(A.send).filter(vis);
      if (sendButtons.length !== 1 || sendButtons[0].disabled ||
          sendButtons[0].getAttribute('aria-disabled') === 'true') throw Error('PROVIDER_SEND_BUTTON_NOT_READY');
      control();
      if (args.expectedOrigin !== location.origin || args.expectedConversationId !== conversationId()) {
        throw Error('PROVIDER_CONVERSATION_CHANGED_BEFORE_COMMIT');
      }
      // Consume the page-side prepare receipt before the irreversible click.
      delete window.__chromeBridgePreparedDraft;
      checkOperationCancelled();
      markOperationSideEffectStarted();
      providerCommitClickStarted = true;
      mutationSideEffectStarted = true;
      sendButtons[0].click();
      providerCommitClickReturned = true;
      const clickedAt = new Date().toISOString();
      await sleep(1200);
      const confirmed = qa(A.stop).some(vis) || replies().length > baseline;
      return { clickedSend:true, clickedAt, baseline, confirmed, requestId:args.requestId,
        preparedId:args.preparedId, payloadHash:actualHash };
    }

    if (name === 'agent_send') {
      if (args.expectedOrigin !== location.origin || !conversationId() || args.expectedConversationId !== conversationId()) throw Error('Conversation changed or has no verified provider identifier');
      const composer = single(A.composer);
      if (!(composer instanceof HTMLTextAreaElement) && !composer.isContentEditable) throw Error('Unsupported composer');
      if (/password|secret|token|credential/i.test([composer.id, composer.name, composer.autocomplete].join(' '))) throw Error('Sensitive composer blocked');
      if (textOf(composer)) throw Error('Existing draft: refusing to overwrite');
      if (!composer) throw Error('Composer not found (not signed in, captcha, or selectors changed): run agent_selftest');
      if (qa(A.stop).some(vis)) throw Error('Agent is still generating');
      const baseline = replies().length;
      const text = args.text;
      checkOperationCancelled();
      markOperationSideEffectStarted();
      composer.focus();
      agentSendDraftMutationStarted = true;
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(composer, text);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        const sel = getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('delete');
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', text);
          composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        } catch { /* перейдём к insertText */ }
        await sleep(150);
        if (!textOf(composer)) document.execCommand('insertText', false, text);
      }
      await sleep(300);
      if (textOf(composer) !== text.trim()) throw Error('Prompt text verification failed');
      let btn = null;
      for (let i = 0; i < 40; i++) {
        // The button may mount after typing. Missing is retryable; ambiguous is not.
        const matches = qa(A.send).filter(vis);
        if (matches.length > 1) throw Error('Ambiguous send selector; refusing to click');
        if (matches.length === 1 && !matches[0].disabled && matches[0].getAttribute('aria-disabled') !== 'true') {
          btn = matches[0]; break;
        }
        await sleep(200);
      }
      if (!btn) throw Error('Unique enabled send button required');
      control();
      if (args.expectedOrigin !== location.origin || args.expectedConversationId !== conversationId()) throw Error('Conversation changed before dispatch; do not retry automatically');
      checkOperationCancelled();
      markOperationSideEffectStarted();
      mutationSideEffectStarted = true;
      btn.click();
      await sleep(1200);
      const confirmed = qa(A.stop).some(vis) || replies().length > baseline;
      if (!confirmed) throw Error('Submission unverified; do not retry automatically');
      return { sent: true, baseline, confirmed, usedButton: true };
    }

    throw Error('Unknown page command: ' + name);
  } catch (e) {
    const safeCode=/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message||'')?e.message:'PAGE_ACTION_FAILED';
    const failure = { error: e.message, failure:{schemaVersion:1,stage:'PAGE_ACTION',code:safeCode,
      durationMs:Math.max(0,Math.min(300000,Date.now()-failureStartedAt))} };
    if (e?.message === 'MUTATION_CANCELLED_BEFORE_SIDE_EFFECT' &&
        trackedOperation && !trackedOperation.sideEffectStarted) {
      failure.dispatchState = 'NOT_PERFORMED';
      failure.sideEffect = 'none';
    } else if (name === 'provider_prepare') {
      failure.dispatchState = 'NOT_PERFORMED';
      failure.sideEffect = providerPrepareMutationStarted ? 'composer-draft-state-unverified' : 'none';
    } else if (name === 'provider_commit') {
      failure.dispatchState = providerCommitClickStarted ? 'UNKNOWN' : 'NOT_PERFORMED';
      if (providerCommitClickStarted) failure.sideEffect = 'send-click-may-have-fired';
    } else if (name === 'agent_send' && agentSendDraftMutationStarted && !mutationSideEffectStarted) {
      failure.dispatchState = 'NOT_PERFORMED';
      failure.sideEffect = 'composer-draft-state-unverified';
    } else if (['browser_click','browser_fill','agent_send'].includes(name)) {
      failure.dispatchState = mutationSideEffectStarted ? 'UNKNOWN' : 'NOT_PERFORMED';
      if (mutationSideEffectStarted) failure.sideEffect = name==='agent_send'
        ? 'send-click-may-have-fired' : 'generic-page-action-may-have-fired';
    }
    return failure;
  } finally {
    releaseActionLock();
    if (trackedOperation) {
      const sideEffectStarted = trackedOperation.sideEffectStarted === true;
      const state = sideEffectStarted ? 'SIDE_EFFECT_STARTED'
        : trackedOperation.cancelRequested ? 'CANCELLED_BEFORE_SIDE_EFFECT'
        : 'NO_SIDE_EFFECT';
      trackedOperation.state = state;
      trackedOperation.finishedAt = Date.now();
      trackedOperation.resolveDone?.({state,sideEffectStarted});
      delete trackedOperation.done;
      delete trackedOperation.resolveDone;
    }
  }
}

