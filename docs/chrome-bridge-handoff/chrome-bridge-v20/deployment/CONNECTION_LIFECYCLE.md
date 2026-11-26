# Chrome Bridge final-release connection lifecycle contract

## Requirement

The connection is a long-running service, NOT a property of the control-panel window.

* First successful local **Connect** records `bridgeConnectionDesired=true` in trusted extension storage.
* **Stop / Disconnect** is the only bridge-wide user control that records `bridgeConnectionDesired=false`. Forgetting credentials also disables auto-connect.
* Close, minimize, refresh, reopen the control panel: no change to the user's desired connection state and **no interruption of the actual browser poller**.
* Temporary 17381 outage: retry safely (bounded backoff) while desired=true, without regenerating tokens or modifying the MCP proxy port 17382.
* Revoke a single AI site's control or revoke all sites: revoke permissions/grants, **not** the bridge transport connection.
* Chrome/browser restart with desired=true: restore the transport if the existing browser token is available and server is running. If server is absent, show recovering state without exposing or silently replacing credentials.
* Control grants are independently time-limited and require explicit local approval; transport autorecovery MUST NOT recreate grants or click/send on a website.
* UI shows the live state of the independent transport (connecting, connected, recovering, manually disconnected, auth failed). The initial label must not misleadingly claim disconnected while the transport is established.

## Current RC status

This branch now records and respects explicit stop intent and restores the connection on panel reopen, while preserving per-origin Control boundaries. However, the command poller is still implemented in `extension/control.js`; closing that document destroys its runtime and interrupts the poll while the panel is closed. This is **NOT** final-release compliance.

## Final architecture gate

Extract command polling, browser command dispatch, cancellation and state ownership from `control.js` into an independent browser-extension runtime. The Chrome Manifest V3 service worker can coordinate a properly lifecycle-managed offscreen document or other supported persistent runtime, but Chrome's MV3 idle/suspension constraints must be explicitly tested. The UI becomes a message-based client, not the poll owner. Keep browser credential storage in trusted contexts, explicit control approvals, host-permission restrictions, and existing server protocol. Never fake `connected` solely from `bridgeConnectionDesired`.

Mandatory E2E acceptance on real Windows/Chrome:
1. Connect, close all control panels, continue issuing browser read-only commands for 5+ minutes and verify responses.
2. Reopen panel: immediate accurate connected status without clicking Connect.
3. Explicit Stop, close/reopen: remain disconnected and produce no new polls.
4. Server crash and relaunch on 17381: recover without manual action; no impact on 17382.
5. Restart Chrome and Windows session while desired=true: reconnect automatically, without granting website Control permissions.
6. Revoke sites: transport remains connected; all site grants revoked.
7. Verify no duplicate pollers, no token leakage and no silently repeated non-idempotent agent_send.
