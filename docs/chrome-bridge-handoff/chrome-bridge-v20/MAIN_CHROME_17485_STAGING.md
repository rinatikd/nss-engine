# Stage 2.5 — isolated main Chrome read-only build (Issue #105)

**Status: BUILD SOURCE READY; NOT INSTALLED.** Do not alter the current Chrome Bridge production services on ports 17381/17382, prior RC1 lab 17481, or PR102 lab 17484.

## Why separate infrastructure

The source's three direct browser-to-bridge endpoints originally point to `127.0.0.1:17381`. Loading the unmodified extension into main Chrome would target production. The staging builder rewrites only those three exact literals and creates **a new directory**, never modifying installed extensions or tokens.

Proposed new isolated server port: **127.0.0.1:17485**. The port and unique server state directory must be provisioned separately; no server has been launched by the script. A new Chrome extension ID and separate browser token must be paired with this server. Do not copy lab/production `config.json` or any secrets.

## Build a separate extension on Windows (when preparing for E2E)

Use a clean checkout of branch `agent/chatgpt/bridge-main-chrome-grok-readonly-20261113`, with Node.js 24 or compatible Node >=22:

```powershell
$root = 'C:\Engineering\chrome-bridge-main-readonly-source\docs\chrome-bridge-handoff\chrome-bridge-v20'
$src = Join-Path $root 'extension'
$stage = 'C:\Engineering\ChromeBridge-Main-17485-Staging\extension'
$manifest = Join-Path $root 'scripts\manifest.main-chrome-17485.json'

# First verify the source came from this exact reviewed branch; never
# replace an existing staging folder or use an installed extension folder.
node (Join-Path $root 'scripts\stage-main-chrome.mjs') $src $stage $manifest 17485
```

This command stages source files only. It does **not** start Chrome, install the extension, connect ChatGPT, create a server or grant page access. A fresh staging directory is required.

## Before any real main Chrome install

1. Run `node --test tests/grok-readonly.test.mjs tests/selected-read-tabs.test.mjs tests/read-grant-tab-lifecycle.test.mjs tests/stage-main-chrome.test.mjs` and full existing test suite. Record the exact commit and Node version. No CI success is currently available.
2. Verify port 17485 is unoccupied and reserve a **new server state directory and browser token**. Ensure the server process binds loopback only and has the new extension ID. Keep it distinct from 17484. The script itself never provisions or changes a server.
3. Review `extension/manifest.json` inside the new staging directory: allowed loopback host is **only** `http://127.0.0.1:17485/*`; optional origins are **only** `https://claude.ai/*` and `https://grok.com/*`.
4. Obtain operator confirmation before loading the new extension into the main Chrome profile via `chrome://extensions` → Developer mode → Load unpacked, selecting the **staged** folder. Do not replace existing Chrome Bridge. Verify distinct extension IDs.
5. In its *local control window*, add Claude/Grok as chat sites and grant precise **selected-tab read** permission for 60 minutes using **Найти вкладки**. Only the user can approve this local UI action. Remote MCP cannot enumerate unapproved selected tabs.
6. The main-profile server needs a **separate tunnel and ChatGPT plugin**, with the corresponding unique ID. Never repoint PR102 lab's active tunnel or copy its tokens.

## Stage 2.6: local server startup — only after unpacked extension ID is known

The independent server entrypoint is `scripts/start-main-17485.mjs`. It requires a
new state directory whose name includes `17485` and `chrome`, an explicit
32-character Chrome extension ID, and a free port. On the first run, it creates
fresh random credentials **inside that directory** and pins the expected
extension ID. The entrypoint never prints those credentials.

1. Run the Node regression suite before installing anything. Only the operator
   can install the reviewed unpacked MV3 package into their actual main Chrome
   via `chrome://extensions`, where its newly assigned extension ID is visible.
   Do not replace or re-use the active PR102 extension.
2. Confirm `127.0.0.1:17485` is unoccupied in a **separate PowerShell window**:

```powershell
if (Test-NetConnection 127.0.0.1 -Port 17485 -InformationLevel Quiet -WarningAction SilentlyContinue) {
  throw 'PORT_17485_ALREADY_IN_USE'
}
```

3. Start *only* the new server in an isolated terminal, substituting the exact
   newly displayed ID (never an existing production/PR102 extension ID):

```powershell
$root = 'C:\Engineering\chrome-bridge-main-readonly-source\docs\chrome-bridge-handoff\chrome-bridge-v20'
$state = 'C:\Engineering\ChromeBridge-Main-17485-State'
$extensionId = '<INSERT_MAIN_PROFILE_STAGING_EXTENSION_ID>'
node (Join-Path $root 'scripts\start-main-17485.mjs') --state $state --extension-id $extensionId
```

The process must say `MAIN_CHROME_17485_READY` and remain open. If any safety
gate fails, it must stop rather than connect to a different server. Do **not**
disable extension-ID/origin checks to make a connection work.

4. In the locally installed staging extension, enter the new **browser token**
   from the *new* state directory via its local control UI. The token is a
   secret: do not paste it into ChatGPT, a GitHub comment, or screenshot. The
   separate `agentToken` is for MCP only; never type it into the browser.
5. To enable ChatGPT remotely, create a **separate main-profile tunnel and
   private plugin**, not a reconfiguration of PR102's active tunnel. Do not
   share the production tunnel key or reuse its state.

No workflow step grants access to existing tabs automatically. Add each site
locally, select the exact tab, review its full URL, grant a 60-minute *read*
permission, and test revocation before any mutation.

**Scope limitation:** This is a source-only workflow; there is no evidence that
port 17485 has been started, the extension installed, or a tunnel created in the
user's main Windows browser.

## Release gates

- Read-only Claude/Grok inventory must show only the approved exact tabs and URLs; Grok response extraction requires live selector calibration.
- Revocation, URL change, expiry, tab close, mid-read revoke and browser restart must fail closed.
- User approval of **writes** is a different workflow and is NOT activated by reading permission. Grok stays discovery-only, and no send E2E has been demonstrated.
- Verify rollback by disabling the new staging extension and stopping only new port 17485 while old channels remain healthy.

### Development-only test evidence

A **copied builder script** was run using Node.js **v22.16.0** in a separate Linux sandbox on 2026-11-13. Static syntax and a synthetic MV3 fixture staging succeeded; reserved port, wrong port, output overwrite and broad optional permission cases failed closed (**5/5 local fixture checks**). This is **not** Node suite/Windows/Chromium E2E and does not certify the staged extension against actual user files.
