# Chrome Bridge v0.2.0 -> visual control release candidate

## Current status
Source-only GitHub staging changes: PR #65 (two explicit per-site connect/disconnect controls), PR #67 (approved local tab screenshot primitive and preview), issues #64 and #66. This snapshot is NOT the running extension until owner deploys it.

## Automated checks
- CI workflow Chrome Bridge Visual RC runs Node 22 tests: visual-snapshot.test.mjs, permissions-adapters.test.mjs; syntax checks control.js, visual-snapshot.js, permissions.js.
- Repository Source checks should complete successfully. Both CI check results must be saved as release evidence for the exact candidate SHA.

## Release blockers — do not publish as installed FINAL while any remain
- [ ] Diff installed C:/Engineering/chrome-bridge/extension/{manifest.json,control.html,control.js,permissions.js,background.js} against archived v20 staging; keep backup and preserve secrets.
- [ ] Confirm manifest grants screenshot capability through a minimal Chrome permission, without broad <all_urls> or new remote host permissions by default.
- [ ] Real Chrome UI test: choose tab ID, local consent, capture, preview, clear, wrong tab, tab-switch race, sensitive pixels, permission denial.
- [ ] Control test: global OFF denies, per-site grant separate, approval window receives user action, revocation/TTL/reconnect clear state.
- [ ] E2E agent_send then agent_wait ACK on CCTV conversation; neither timeout nor unknown send may automatically retry.
- [ ] Re-check installed bridge 127.0.0.1:17381 and MCP 17382; compare 18 registered tools and maintain authorizations.
- [ ] Verify rollback to saved release, without changing credentials, tunnel, CODEX_DISABLED, AutoCAD.
- [ ] Owner accepts release and explicitly installs updated extension.

## Known limitations
Screenshot image is shown only in local control UI. No remote screenshot MCP tool and no AI image classification are yet wired. Automatic debugging remains limited to the currently available browser read/agent tools; browser actions require local consent. The capture button requires selected target tab active in its window; when Chrome denies capture permission it fails with a user-visible error.

## Rollback
Do not merge stacked PRs into main as if independent. Save a timestamped local backup of extension and manifest before applying. On any failure revert copied UI files from backup, reload extension, and verify browser_status plus origin read-only access. No secrets in GitHub.