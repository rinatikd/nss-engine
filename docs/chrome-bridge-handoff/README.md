# Chrome Bridge handoff for NSS Engine / ChatGPT review

This directory is a review snapshot of Chrome Bridge staging work v17–v20 plus the separate direct ChatGPT→local CLI v21 prototype. It is staged for review and final-release assembly; it is not an approved production release.

## Layout

- `chrome-bridge-v20/`: source-only v20 staging snapshot, tests, deployment scripts, selected native runner v0.7 source, and the recovered v0.20 CORS rollback source. `package.json.template` and `plugin.json.template` preserve source metadata without committing raw JSON files.
- `direct-cli-v21/`: standalone stdio MCP server, secure tunnel launcher and setup notes. Execution is hard-disabled; local tunnel binaries and credentials are intentionally omitted.
- `reports/STAGING_HISTORY.md`: sanitized v17–v20 results and limitations. Raw reports, production PIDs, logs, local config, credentials, ZIPs and binary build outputs are excluded.
- `SHA256SUMS.txt`: hashes of all files in this handoff snapshot except the manifest itself.

## Review boundaries

The v20 production-quality gap remains: no real provider send/reply correlation, no trusted extension toolbar wakeup evidence, no validated Windows isolation runner, and no final production cutover evidence. Grok and Qwen must remain outside Control. Direct CLI execution remains `CODEX_DISABLED`.

This is an overlay for the public `rinatikd/nss-engine` repository, not a replacement for its NSS Engine files. Review it on a separate `agent/codex/...` branch and open a PR; do not merge it into `main` automatically. Source/test files were selected under the target repository's artifact restrictions; no tunnel executable, archive, raw log, credential, production configuration or drawing is included.

## Rebuild guidance

Use Node.js 20+ for the direct MCP prototype. For Chrome Bridge, reconstruct release metadata from the `.template` files as needed in an isolated build directory and run the documented staging suites. Do not enable Codex execution to make a release appear complete. A release candidate must retain the explicit NO-GO gaps above.

