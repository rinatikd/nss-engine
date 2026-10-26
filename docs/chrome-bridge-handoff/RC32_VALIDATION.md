# Chrome Bridge RC32 — независимая проверка и схема интеграции

**Источник:** Codex handoff PR #31, commit `478af8ebb7611a72636e59ba8e8246306592e989`. **Цель:** Issue #32.

## Статус и границы
Это source-only **кандидат для проверки**, а не production-релиз. Данный PR намеренно основан на handoff-ветке Codex (stacked PR), чтобы показать только изменения независимого этапа. `main` и production не затрагиваются.

## Воспроизводимая минимальная проверка v21
Из корня репозитория:
```powershell
node --check docs/chrome-bridge-handoff/direct-cli-v21/src/server.mjs
node --test docs/chrome-bridge-handoff/direct-cli-v21/tests/contract.test.mjs
```
Тест создаёт только дочерний Node-процесс отдельного **transport-only** stdio MCP. Он не вызывает Codex CLI, не открывает туннель и проверяет явный `CODEX_DISABLED`, три advertised tool schemas, ошибочные аргументы и shutdown.

## Незакрытая матрица для полноценного RC
| Контроль | Доказательство | Порог |
|---|---|---|
| SHA/base | отдельная проверка hash manifest + fixed source SHA | PASS |
| Unit | `node --test` для v20, отчёт runtime/version | PASS либо подробный FAIL |
| Origin/Control | три точных origin, 10-минутный grant, expiry/revoke, отсутствие Grok/Qwen write | PASS |
| MCP | tools/list schema, negative bearer/origin, reconnect | PASS |
| MV3 | реальная установка в изолированный Chrome; CDP worker и trusted toolbar wakeup отдельно | PASS / BLOCKED |
| Journal | restart/duplicate/UNKNOWN, corrupt/locked/full, origin+conversation identity | PASS / BLOCKED |
| Live provider | отдельное явное разрешение, тестовая беседа, exact answer attribution | BLOCKED без разрешения |
| v21 | stdio contract/fail-closed, локальный аудит key exposure/tunnel | PASS / BLOCKED |
| Rollback | запуск из isolated profile/ports с восстановлением старой версии | PASS / BLOCKED |
| Windows runner | подтверждённая OS isolation и native failure behavior | BLOCKED до аттестации |

## Безопасность
Не менять production ports/config/credentials, не сливать PR автоматически, не включать локальное исполнение Codex. `CODEX_DISABLED` остаётся обязательным. Запретить write-Control для Grok/Qwen, пока нет отдельного approval. Не публиковать исходные CAD-файлы, ключи или сырые логи.

## Дальнейший порядок
1. CI тестирует минимальный транспортный контракт и независимые v20 suites.
2. Второй агент делает review code changes относительно этого head.
3. Codex CLI на Windows выполняет доступные нативные и trusted-click сценарии в isolated profile, публикует санитизированные свидетельства.
4. Только после устранения BLOCKED формируется отдельное решение о production cutover; никакого автоматического merge.
