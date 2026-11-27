# Chrome MV3 screenshot permission — deployment review

Current archived source does **not** contain the live `extension/manifest.json`. Do not replace the installed manifest with a guessed copy.

## Verified API behavior
Official Chrome Extensions tabs.captureVisibleTab documentation requires `activeTab` or `<all_urls>` permission. The latter is excessively broad and NOT accepted for this release candidate. Add `activeTab` to the existing `permissions` array **only after comparing the real installed manifest**; preserve all existing permissions, background service worker, extension ID and host settings. Chrome's optional per-origin `chrome.permissions.request({origins:[...]})` is not an alternative to this API-level permission.

Suggested minimal delta if the installed manifest currently has `["storage","scripting"]`:

```diff
-  "permissions": ["storage", "scripting"],
+  "permissions": ["storage", "scripting", "activeTab"],
```

Do NOT apply this example verbatim without verifying the actual file; its formatting and entries may differ.

## Screenshot user journey
1. On the **target site**, click the Chrome Bridge toolbar icon. Chrome may then grant the extension temporary `activeTab` access to that clicked tab. The extension records its tabId in session storage and opens the control page.
2. Bring the target tab to the foreground of its window while keeping the control page visible in a different window where possible.
3. Click **Сфотографировать выбранную вкладку** in the control page. Confirm exact tab title, site and privacy warning. The extension checks tab identity before and after capture. It never switches the target tab by itself.
4. Preview stays local; press **Удалить локальный снимок** to release the image from preview.
5. If Chrome denies capture, show the real error. No fallback to `<all_urls>`, CDP or hidden cross-origin capture.

`activeTab` is temporary, can expire on navigation and is granted only through supported extension invocation. A click inside the already-open control page does not itself automatically grant `activeTab` on a different tab. These details require manual verification in Chrome.

## Release blocker
Before declaring final: test the installed manifest, toolbar workflow, exact target title/ID, known/sensitive page boundaries, denied permissions, and that screenshots never leave the browser automatically.
