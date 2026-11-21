# Chrome Bridge — пакет независимого анализа для ИИ

**Подготовлено:** 2026-11-21 (Asia/Almaty)  
**Репозиторий:** `rinatikd/nss-engine`  
**Назначение:** передать независимому ИИ полный зафиксированный исходный пакет Chrome Bridge, архитектурные материалы и воспроизводимый контекст дефектов.  
**Режим:** анализ и рекомендации בלבד; никаких изменений кода, запусков, отправки сообщений провайдерам или действий в Production без отдельного разрешения владельца.

---

## 1. Обязательные исходные ревизии

Не смешивать ревизии. Анализировать каждую отдельно и явно указывать SHA.

| Обозначение | Ревизия | Что это |
|---|---|---|
| **BASE / PR113** | `fcbd6eeaf646131ba696995bd970482b5704ed56` | Исходная ревизия Chrome Bridge, к которой относится основной source audit |
| **PR121** | `f5b08f03f2868886f334453a55bb39a5596c3b65` | Test-only Stop-vs-pageAction race reproducer; не считать production fix |
| **PR120** | `1e48164571166de0ad0aadd99e23813193cccc89` | Архитектурный контракт Transport / Orchestrator и source-audit report |

Полезные ссылки:

- [Chrome Bridge v2.0 — полный снимок BASE](https://github.com/rinatikd/nss-engine/tree/fcbd6eeaf646131ba696995bd970482b5704ed56/docs/chrome-bridge-handoff/chrome-bridge-v20)
- [SHA256SUMS для handoff snapshot](https://github.com/rinatikd/nss-engine/blob/fcbd6eeaf646131ba696995bd970482b5704ed56/docs/chrome-bridge-handoff/SHA256SUMS.txt)
- [PR113 — исходный код и обсуждение](https://github.com/rinatikd/nss-engine/pull/113)
- [PR120 — транспортный контракт и аудит](https://github.com/rinatikd/nss-engine/pull/120)
- [PR121 — race reproducer](https://github.com/rinatikd/nss-engine/pull/121)
- [Issue #122 — AI Council / вопросы независимого анализа](https://github.com/rinatikd/nss-engine/issues/122)

**Важно:** snapshot в BASE содержит 139 файлов, около 629 KB, по дереву GitHub. Это исходный снимок из репозитория, а не подтверждение, что он совпадает с текущими локальными файлами Production или PR102 Lab.

## 2. Состав исходного пакета

Папка `docs/chrome-bridge-handoff/chrome-bridge-v20/` в BASE включает:

- `extension/` — Manifest V3, background coordinator, Control UI, grants/permissions, one-click mutation, page actions, transport worker/host, reconnect/recovery, snapshots и adapters;
- `server/` — MCP/HTTP bridge, tool schemas, browser-key store, agent binding, send journal и outcome classifier;
- `tests/` — unit/integration tests, coordinator, transport ACK, Stop, approvals, journal, recovery, provider adapters, E2E fixtures;
- `native/windows-runner-v07/` — native Windows runner и IPC;
- `deployment/` — Windows staging, preflight, cutover, health, rollback, process identity и watchdog scripts;
- `rollback-candidates/` — отдельные rollback candidate файлы; не смешивать с основным путём исполнения;
- `README_RU.md`, `ORCHESTRATOR.md`, `CONTROL_PERMISSIONS.md`, release checklist/evidence и другие проектные документы.

Сначала прочитать README и release evidence; затем проследить реальные entry points и imports. Не считать каждый файл из handoff папки активным runtime-файлом: определить, что реально импортируется/запускается, что является шаблоном, документацией или rollback candidate.

## 3. Уже выявленный критический вопрос

В source audit для BASE зафиксирован P0-риск: Global Stop может отключить будущие dispatches и послать Stop в offscreen Worker, но ACK Worker не доказывает, что уже внедрённый page action прекратился или стал инертным. Возможен сценарий, в котором page action, ожидающий Send-button readiness, продолжает выполнение и вызывает `btn.click()` после ответа Stop.

Это source-level finding, не доказательство live Chrome reproduction.

PR121 добавляет test-only reproducer, который использует реальный импортированный `installBackgroundCoordinator()`, `dispatchOneClickMutation()`-путь и `pageAction` на synthetic DOM, удерживает readiness wait, вызывает Stop, затем освобождает barrier. Проверьте сам тест на корректность, детерминированность, cleanup и bounded timeout. У тестового barrier ранее отмечен риск отсутствия собственного timeout: возможен зависающий тест. Не трактовать наличие PR121 как исправление production race.

PR120 описывает целевой контракт: отдельные transport и orchestrator, per-tab single-writer, Prepare/Commit, Stop epoch/fencing, drain/linearization, durable journal/recovery, привязка к conversation и строгие UNKNOWN-состояния.

## 4. Задание независимому ИИ

Выполните глубокий технический аудит, не ограничиваясь README и предыдущими выводами.

### A. Воспроизводимость исходного анализа
1. Подтвердите доступность всех указанных SHA и точные пути файлов.
2. Проверьте SHA256SUMS относительно файлов snapshot, если можете получить исходники без потери байтов.
3. Разделите active runtime, tests, docs, templates, rollback candidates и экспериментальный код.
4. Постройте карту архитектуры: Chrome extension → background coordinator → offscreen transport → local bridge/MCP → provider tabs; отдельно укажите native runner и Windows deployment.
5. Для ключевых выводов укажите точные файлы, функции и строки/фрагменты.

### B. Безопасность и correctness
Проверьте как минимум:
- Global Stop и per-tab revoke: fencing, in-flight registry, drain, commit linearization, cancellation semantics;
- гонки между dispatch, Stop, Disconnect, tab close/navigation, permission revoke, reconnect и worker restart;
- разницу между Worker ACK, page-action completion, message sent, reply observed и verified;
- conversation identity и binding lifecycle (включая SPA state, tab reuse, URL changes);
- параллелизм: глобальный activeId, per-tab serialization, независимые read lanes, starvation/deadlocks;
- idempotency, duplicate sends, late results, timeout, retries, UNKNOWN quarantine;
- SendJournal: durability, locking, atomicity, fsync, integrity, key handling, rotation/compaction, crash recovery;
- local HTTP/MCP boundary: auth, origin/CORS, localhost exposure, request validation, replay, privilege boundaries;
- extension permissions, host grants, content scripts, message origin validation, prompt injection и untrusted provider content;
- Windows runner IPC, process identity, ACLs, lifecycle, orphan processes и rollback safety;
- secrets, logs, telemetry, data retention и отсутствие credentials в репозитории.

Не предлагайте «exactly once» для DOM/provider interaction без доказуемого протокола. Если результат неоднозначен, состояние должно оставаться UNKNOWN и не должно запускаться автоматическое повторное сообщение.

### C. PR121 reproducer
1. Сопоставьте тест с реальным source flow, без подмены ключевых функций mock-реализациями.
2. Найдите все способы, которыми тест может дать false PASS/false FAIL или зависнуть.
3. Проверьте, действительно ли тест ловит текущий дефект BASE.
4. Предложите минимальные улучшения теста: timeout на каждом barrier, гарантированный cleanup, восстановление глобальных объектов при исключениях, независимые assertions на Stop ACK и page-action drain, детерминированная event trace.
5. Предложите матрицу race tests для Stop до injection, во время readiness wait, непосредственно перед click, после commit, при tab close и при worker restart.
6. Не вносите изменения в PR121. Только рекомендации и patch proposal в отчёте.

### D. Архитектурные альтернативы
Сравните не менее двух вариантов реализации:
- coordinator-owned in-flight operation registry + per-tab fencing epoch + drain;
- иной безопасный протокол, если он объективно проще/надёжнее.

Для каждого укажите инварианты, failure modes, сложность миграции, совместимость с Manifest V3/service worker suspension и критерии приёмки.

### E. Release gate / Windows E2E
Сформируйте конкретный план:
- unit tests;
- Node runtime tests;
- Windows PowerShell 5.1/7 compatibility, если применимо;
- isolated Chrome profile;
- отдельный Lab port/profile;
- test provider fixture без реальной отправки;
- Stop/Disconnect race;
- reconnect, crash/restart, journal recovery;
- rollback rehearsal;
- production isolation checks.

Не утверждайте, что Windows E2E или live provider tests пройдены, если у вас нет логов с точным SHA, средой, временем и результатами.

## 5. Ограничения и безопасность передачи

- Только чтение и анализ. Не push/commit/merge, не менять PR, не менять issue.
- Не запускать скрипты из `deployment/` и `native/` без отдельного разрешения.
- Не подключаться к Production endpoints 17381/17382 и не обращаться к локальным credentials.
- Не включать Control, не выдавать host permissions, не отправлять сообщения в Claude/Gemini/DeepSeek/Kimi/Grok/Qwen или другие provider tabs.
- Не публиковать токены, API keys, cookies, browser storage, персональные данные и локальные пути с именами пользователей.
- Не считать GitHub Actions зелёными или красными без исполняемых логов. В предыдущем сборе по PR121 были workflow/job records с пустыми steps и отсутствующими логами; это **UNKNOWN / NOT EXECUTED**, а не доказанный тестовый FAIL.
- Не использовать Codex CLI до 30 ноября 2026 включительно.
- Если обнаружите секрет в snapshot, сообщите только путь и тип риска, не копируйте значение.

## 6. Формат итогового отчёта

Верните один отчёт со следующими разделами:

1. **Executive verdict:** GO / CONDITIONAL GO / NO-GO для mutation-capable release; отдельно verdict для read-only diagnostics.
2. **Scope and exact SHAs:** какие ревизии реально проверены.
3. **Architecture map:** компоненты, entry points, trust boundaries.
4. **Findings:** ID, severity, confidence, file/function/line, impact, reproduction, remediation.
5. **PR121 test review:** coverage gaps, false-pass risks, bounded-timeout assessment.
6. **Architecture recommendation:** выбранный вариант и отвергнутые альтернативы.
7. **Patch plan:** минимальные изменения, порядок, тесты, rollback.
8. **Windows E2E plan:** конкретные команды/ожидаемые артефакты, но ничего не запускать.
9. **Unknowns:** всё, что нельзя подтвердить только по GitHub snapshot.
10. **Acceptance criteria:** измеримые условия PASS/FAIL/UNKNOWN.

Каждое утверждение помечайте одним из статусов:
- **CONFIRMED** — подтверждено кодом/документом/исполняемым логом;
- **REPRODUCED** — воспроизведено в контролируемой среде с артефактами;
- **INFERRED** — логический вывод из исходников;
- **UNKNOWN** — данных недостаточно.

В конце дайте короткий список из 5 наиболее важных действий по приоритету. Не создавайте PR и не исправляйте код.

---

## 7. Как начать анализ

1. Откройте BASE tree и скачайте snapshot целиком, сохранив структуру каталогов.
2. Сверьте контрольные суммы.
3. Прочитайте `README_RU.md`, `RELEASE-RC1.md`, `RELEASE_CANDIDATE_CHECKLIST.md`, `deployment/RELEASE_EVIDENCE_20261115.md`, `ORCHESTRATOR.md`, `CONTROL_PERMISSIONS.md`.
4. Проследите кодовые пути из раздела 3 по реальным imports.
5. Отдельно изучите PR120 contract и PR121 reproducer, не подменяя ими BASE.
6. Подготовьте отчёт по разделу 6. Все неисполненные проверки оставьте UNKNOWN.

**Ключевой вопрос:** как гарантировать, что после успешного ответа Global Stop ни одна ранее принятая операция не сможет выполнить поздний provider-side mutation — и как это доказать тестами и журналом?
