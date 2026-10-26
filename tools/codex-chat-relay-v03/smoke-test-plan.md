# Separate synthetic host sandbox smoke-test plan (NOT RUN)

Status: **BLOCKED / requires a separate operator approval after review**.

Before any future test, an operator must independently verify the effective tool inventory across built-in tools, managed/system/project/user configuration, inherited environment, MCP/plugins/apps, executable signature/version/hash, and Windows host sandbox enforcement. This profile or an empty `CODEX_HOME` is insufficient evidence.

If separately approved, use a disposable Windows account or VM with no credentials, no network, a fresh dedicated profile created only from the reviewed allowlist, and an isolated writable test directory. The only synthetic prompt should request the fixed text `relay-v03-sandbox-ok`. Observe process/file/network boundaries with host security telemetry, prove no tool starts and no files outside the test directory are accessible, then destroy the VM/profile. Abort on any unreviewed effective tool or policy source. This repository intentionally contains no runnable smoke-test command or gate override.
