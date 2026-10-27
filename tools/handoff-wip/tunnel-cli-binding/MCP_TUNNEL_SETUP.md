# ChatGPT Secure MCP Tunnel — runnable connector

The package now includes `tunnel_connector.py` and `tunnel_mcp_entry.py`. Use official `tunnel-client` v0.0.18. The connector binds the tunnel to `unified_runtime.py`: one Application controls the loopback UI and MCP worker. Do not start a separate `web_app.py` or `mcp_bridge.py` against this database.

## What remains account-side

A real tunnel must exist in the target Platform organization and be associated with the intended ChatGPT workspace. The runtime principal needs Tunnels Read + Use. Creating/managing the tunnel needs separate Tunnels Manage privileges; this launcher never performs tunnel CRUD or uses an admin key.

Official v0.0.18 help points to:

- Tunnels: https://platform.openai.com/settings/organization/tunnels
- Runtime keys: https://platform.openai.com/settings/organization/api-keys
- ChatGPT apps/connectors: https://chatgpt.com/#settings/Connectors

Create/authorize the private custom MCP app for the same tunnel while its daemon is running. Account UI labels and app confirmation policies must be verified in that account. Repository source publication does not install an app or share local machine access with another account.

## Prepare once

Use absolute paths. Keep the generated profile in a private runtime directory outside source control. Set the real, non-secret tunnel ID locally; the placeholder below must be replaced. Supported syntax is `tunnel_<32 lowercase letters or digits>` or `tunnel_<4-character lowercase/digit namespace>_<32 lowercase letters or digits>`. Syntax validation does not verify that the ID exists or belongs to the intended account. Do not send runtime/admin keys in chat.

PowerShell, from this package directory:

```powershell
$python = (py -3.14 -c "import sys; print(sys.executable)").Trim()
$client = 'C:\path\to\verified\tunnel-client.exe'
$db = Join-Path $PWD 'state\interface.sqlite'
$profiles = Join-Path $env:LOCALAPPDATA 'NSS-A2A\tunnel'
$env:CONTROL_PLANE_TUNNEL_ID = 'REPLACE_WITH_REAL_PLATFORM_TUNNEL_ID'
& $python -B tunnel_connector.py prepare --client $client --db $db --profile-dir $profiles
```

The launcher writes a canonical JSON document in `.yaml` format (JSON is valid YAML), using the fields shown by `tunnel-client profiles samples show sample_mcp_stdio_local`. The profile contains a fixed stdio command and `env:CONTROL_PLANE_API_KEY`, never a key value. Exclusive creation protects an existing profile from overwrite. Changing the source location, Python path, database, tunnel ID or UI port requires reviewing/replacing the old non-secret profile deliberately.

## Check and launch

If a protected runtime environment already supplies `CONTROL_PLANE_API_KEY`, use:

```powershell
& $python -B tunnel_connector.py check --client $client --db $db --profile-dir $profiles
& $python -B tunnel_connector.py doctor --client $client --db $db --profile-dir $profiles
& $python -B tunnel_connector.py run --client $client --db $db --profile-dir $profiles
```

For a local interactive terminal, add `--prompt-key` to `doctor` and `run`. Each process reads its runtime key in a hidden prompt, passes it only through the child environment, and never writes it into the profile or command arguments. Non-interactive prompt fallback is refused. The key is not persisted, so a new launcher process prompts again.

`check` is offline except for the local `--version` subprocess. It reports only booleans and does not prove network authorization, binary publisher identity or ChatGPT discovery. `doctor` is an explicit official client preflight with a 45-second limit; raw output is suppressed because diagnostics can include local config details. `run` stays in the foreground; stop it with Ctrl+C. No model task is submitted by the launcher.

Open the shared UI at `http://127.0.0.1:8765`. Set `--ui-port` consistently for prepare/check/doctor/run to choose another port. The tunnel's own health/admin listener requests an ephemeral loopback port, independent of this UI. Ambient client profile/MCP/remote-UI/logging settings are stripped so they cannot replace the fixed profile. Session HTTPS proxy and CA environment are preserved. The spawned MCP process removes tunnel runtime/admin and OpenAI fallback keys from its environment before importing the shared runtime; this avoids accidental credential inheritance, but is not a process isolation proof.

## Verify from ChatGPT

Discover the nine dispatcher tools, call `dispatcher_health`, and confirm the expected local models. Submit a synthetic task with a fresh 32-character hexadecimal `request_id`; UUIDv4 hex is one valid choice, not a requirement. Reuse identical ID and payload on uncertain retries: same payload returns EXISTS, changed payload returns CONFLICT. Read it with `dispatcher_get_task`, retaining the ID. The catalog intentionally has no task enumeration; task status does not expose original prompts/rubrics or worker requests.

A successful local doctor, daemon health or command-line MCP test is not proof of a ChatGPT app call. Keep the daemon running during discovery and every app call. Only a completed submit/status exchange initiated through the actual ChatGPT app proves that connection. Starting a worker and sandbox smoke are write tools; inspect the app's confirmation settings. No Codex task is exposed by this MCP catalog; CODEX_DISABLED is unchanged. AI COMPLETED is not human acceptance or GitHub publication.

Offline launcher tests: `python -m unittest -v test_tunnel_connector`. Actual account authentication and tunnel exchange remain separate checks.

Offline validation performed here: 12 launcher tests PASS. Official v0.0.18 accepted the generated JSON-as-YAML through `profiles add --from-file` in an isolated temporary directory and rejected a malformed YAML control case. Neither command started a tunnel, contacted an account, or ran a model.

## Проверка транспорта без внешнего аккаунта

```sh
python verify_local_tunnel.py --client /absolute/path/to/tunnel-client --timeout 40
```

Проверено на Linux с настоящим tunnel-client0.0.18 dev proxy: локальный control plane → stdio unified runtime → MCP initialize/list_tools(9)/health/submit/get/cancel. Задача сохранена и отменена. Это проверка транспорта без модели и внешнего аккаунта; hosted_tunnel_verified и chatgpt_app_verified остаются false. Временные процессы/профиль/БД удаляются. Не используйте этот dev proxy вместо внешней защищённой регистрации.
