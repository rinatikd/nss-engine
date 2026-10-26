// Р¤СѓРЅРєС†РёСЏ, РєРѕС‚РѕСЂР°СЏ С†РµР»РёРєРѕРј СЃРµСЂРёР°Р»РёР·СѓРµС‚СЃСЏ Рё РІС‹РїРѕР»РЅСЏРµС‚СЃСЏ Р’РќРЈРўР Р СЃС‚СЂР°РЅРёС†С‹ (chrome.scripting.executeScript).
// РћРЅР° РЅРµ РґРѕР»Р¶РЅР° СЃСЃС‹Р»Р°С‚СЊСЃСЏ РЅРё РЅР° С‡С‚Рѕ СЃРЅР°СЂСѓР¶Рё. Р’РѕР·РІСЂР°С‰Р°РµС‚ РґР°РЅРЅС‹Рµ РёР»Рё {error}.
export async function pageAction(name, args, expectedOrigin) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (e) => !!e && e.getClientRects().length > 0;
  const qa = (s) => { try { return s ? [...document.querySelectorAll(s)] : []; } catch { return []; } };
  const one = (s) => qa(s).find(vis);
  const conversationId = () => {
    const routes = {
      'https://claude.ai': /^\/chat\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://gemini.google.com': /^\/app\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
      'https://chat.deepseek.com': /^\/a\/chat\/s\/([a-zA-Z0-9_-]{8,128})(?:\/|$)/,
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
    const control = () => {
      if (!['https://claude.ai', 'https://gemini.google.com', 'https://chat.deepseek.com'].includes(location.origin) ||
          location.origin !== expectedOrigin || !(args.controlExpires > Date.now())) throw Error('Control denied: local re-grant required');
    };
    if (['browser_click', 'browser_fill', 'agent_send'].includes(name)) control();
    if (location.origin !== expectedOrigin) throw Error('Tab navigated to another origin');

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
      e.click();
      return { clicked: true };
    }

    if (name === 'browser_fill') {
      const e = single(args.selector);
      verifyExpect(e, args.expect);
      const isTA = e instanceof HTMLTextAreaElement;
      if (!isTA && !(e instanceof HTMLInputElement)) throw Error('Expected text input or textarea');
      if (e instanceof HTMLInputElement && !['text', 'search', 'email', 'url', 'tel'].includes(e.type)) throw Error('Sensitive or unsupported input type');
      if (/password|passwd|secret|token|credit|cardnumber|cc-number|one-time-code|cvv|cvc/i.test([e.name, e.id, e.autocomplete].join(' '))) throw Error('Sensitive field blocked');
      const proto = isTA ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, args.text);
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    }

    // ---------- Р°РіРµРЅС‚СЃРєРёРµ С‡Р°С‚С‹ (Р°РґР°РїС‚РµСЂ РїСЂРёС…РѕРґРёС‚ РІ args.adapter) ----------
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
      composer.focus();
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
        } catch { /* РїРµСЂРµР№РґС‘Рј Рє insertText */ }
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
      btn.click();
      await sleep(1200);
      const confirmed = qa(A.stop).some(vis) || replies().length > baseline;
      if (!confirmed) throw Error('Submission unverified; do not retry automatically');
      return { sent: true, baseline, confirmed, usedButton: true };
    }

    throw Error('Unknown page command: ' + name);
  } catch (e) { return { error: e.message }; }
}

