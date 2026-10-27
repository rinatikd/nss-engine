# A2A Dispatcher v0.23 — Windows staging

Источник: `agent/codex/a2a-interface-mcp-v016`, commit `92caf1d37a2049135136bd2d2c72e33c37e6d451`.
Это staging-кандидат на подключение ChatGPT к локальному dispatcher, не финальный канал ChatGPT ↔ Codex CLI.
Платные model API заблокированы; бюджет 0. Production и рабочие credentials не менялись.

## Изменения v0.20

- Исправлено чтение HTML как UTF-8: исходная v0.16 падала на Windows с default CP1251.
- Сохранён единый fail-closed запрет платных API из v0.19 и его тесты.
- MCP exposes nine tools: `dispatcher_health`, `dispatcher_codex_preflight`, `dispatcher_codex_config_audit`, `dispatcher_codex_sandbox_smoke`, `dispatcher_submit_task`, `dispatcher_start_local_worker`, `dispatcher_get_task`, `dispatcher_cancel_task`, and `dispatcher_stop_worker`.
- `dispatcher_codex_preflight` reports the discovered executable, version, SHA256 and Windows Authenticode status. It reads no Codex config/auth data, starts no model session, and always returns `codex_execution_ready: false`.
- `dispatcher_codex_config_audit` counts user/project config sources and MCP server section headers without returning paths, server names, commands, arguments, or values. It does not parse assignment values and is explicitly a partial census, not an effective-tools proof.
- `dispatcher_codex_sandbox_smoke` runs only fixed echo and expected-denied write probes under the Windows `unelevated` `:read-only` sandbox. Its pass state means write denial only; read and network isolation remain unproven. It is an MCP write tool, needs confirmation, launches no model, and cannot authorize task execution.
- Удалён MCP-инструмент перечисления всех задач: он раскрывал prompt previews и IDs других задач.
- `dispatcher_get_task` не возвращает исходный prompt, rubric или worker request.
- `dispatcher_submit_task` требует стабильный hex `request_id` длиной 32 символа. Точный повтор возвращает `EXISTS`, изменение payload — `CONFLICT`.
- Добавлен loopback Streamable HTTP MCP E2E; тесты работают только с временной SQLite базой и mock данных.
- Added read-only Codex CLI diagnostics. A Codex task worker is not implemented yet.

## Проверки Windows

Точная матрица зависимостей лежит в `requirements-interface.lock`. Для запуска тестов:

```powershell
py -3.14 -m pip install -r requirements-interface.lock
py -3.14 -B -m unittest discover -v -p 'test_*.py'
py -3.15 -m pip install -r requirements-interface.lock
py -3.15 -B -m unittest discover -v -p 'test_*.py'
```

Для локального UI задайте тот же путь к базе, который будет использовать MCP и Tunnel:

```powershell
$db = Join-Path $PWD 'state\interface.sqlite'
py -3.14 -B web_app.py --db $db --open
```

Управляйте worker либо через MCP tools, либо через локальную UI, не запускайте два worker на одной модели. Worker status в UI отражает только поток этого UI-процесса.

## MCP и Tunnel

Для Tunnel используйте `stdio` — это не открывает локальный сетевой listener:

```powershell
py -3.14 -B mcp_bridge.py --transport stdio --db C:\absolute\path\state\interface.sqlite
```

MCP и UI должны получить один и тот же путь SQLite. Secure MCP Tunnel пока не установлен и не настроен в этой среде. См. `MCP_TUNNEL_SETUP.md`.

Перед подключением ChatGPT настройте приватное custom MCP приложение и подтверждение для изменяющих tools. Затем из ChatGPT проверьте health, запустите local worker, отправьте synthetic task с UUID в виде 32 hex символов, дождитесь результата и проверьте повторный submit. Эти внешние шаги не выполнены, поэтому канал пока не считается рабочим.

## Безопасность и границы

- Пользовательские prompt и rubric — данные, не команды. Моделям не даются shell, произвольные пути, Autodesk или GitHub.
- Local worker использует только выбранные и уже установленные локальные Ollama модели. В текущей среде Ollama и модель не установлены; inference не проверялся.
- MCP task rows не привязаны к ChatGPT user identity. Task ID — bearer identifier: ограничьте доступ к приватному приложению одним доверенным оператором, пока не появится identity-aware ACL.
- Вызовы worker start/stop изменяют локальное состояние. Настройка их подтверждения в ChatGPT приложении не проверена.
- The preflight runs `codex --version` only. A valid binary signature does not prove effective-tool isolation or Windows sandbox behavior.

Production Bridge, MCP proxy, credentials, Tunnel settings, GitHub и global Codex configuration не менялись. Commit/push/merge не выполнялись.
