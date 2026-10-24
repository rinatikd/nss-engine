# Очередь совместной работы NSS

Обновлено: 2026-10-24, Asia/Qyzylorda. Текущий `main` / `origin/main` `7d003ada368833f6a825eb2ebf2d43f8b676a064`; основная копия обновлена fast-forward после merge PR #6. Статусы: `proposed` — описано; `ready` — входы и канал проверены; `sent` — передано; `accepted`/`acknowledged` — подтверждено; `in_progress` — начато; `review`/`reviewed` — проверено; `integrated` — в `main`. `blocked_*`, `waiting_user` и `rejected` фиксируют открытый блокер.

## COORD-01 — единая проверенная база

- **Issue:** [#5](https://github.com/rinatikd/nss-engine/issues/5).
- **Исполнитель:** Codex CLI, основной ПК / текущая сессия координатора.
- **Проверяющий:** владелец проекта; отдельный проверяющий не назначен.
- **База:** `main` `40e4069fec420fe188cdfb38cc9cf2ee94aae603`.
- **Разрешённые файлы:** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/*.md`; для SEC-01 — `requirements-test.txt`, `tools/repo_guard.py`, `tools/test_repo_guard.py`, `tools/run_portable_checks.py` и его отчёт.
- **Критерии:** фактические статусы PR и CI; независимый просмотр SEC-01; очередь с полными карточками и честными статусами; конкретные задания Claude/DeepSeek переданы и проверены либо записан подтверждённый блокер; штатная интеграция через GitHub; без секретов, платных ресурсов и пользовательских чертежей.
- **Зависимости:** сначала установить, что делать с PR #1 и уже закреплённой в `main` Shapely; затем привести PR #2 к актуальной базе и снять замечания; SEC-01 проверять на актуальной базе после этих изменений.
- **Статус:** `integrated`. PR #6 merged обычным merge в `main` `7d003ada368833f6a825eb2ebf2d43f8b676a064`; PR #1 merged; PR #2 закрыт как superseded. `Source checks` run 37 success; SEC-01 independently reviewed.
- **Контрольная точка:** продолжать аудит каналов Claude/DeepSeek/Cursor; не помечать задания `sent` пока нет фактической передачи.

Проверка пересечений: PR #1 и PR #2 затрагивают общую документацию и унаследованную зависимость; SEC-01 меняет только repo guard/его portable runner и отдельный отчёт. Claude/DeepSeek — read-only ревью без записи, но пока не отправлены. Одновременных write-назначений нет.

## Интеграция PR #1 — часть COORD-01

- **Исполнитель:** автор PR `@rinatikd`; точный агент-исполнитель по API не установлен (ветка `agent/codex-desktop/connectivity-check`).
- **Проверяющий:** Claude-сгенерированный отчёт в [комментарии PR #1](https://github.com/rinatikd/nss-engine/pull/1#issuecomment-6378273917); формальных GitHub reviews — 0.
- **База и head:** PR создан от `79a53fec612b80c1c6cf3afff6c39931f5939675`; head `e95e0d4fd3ff4228e0d01ccbcef4a60214e57082`. Текущий `main` — `40e4069fec420fe188cdfb38cc9cf2ee94aae603`.
- **Разрешённые файлы:** `requirements-test.txt`, `docs/CODEX_DESKTOP_CONNECTION.md`.
- **Критерии:** зависимость тестов закреплена; отчёт подключения отделяет фактические проверки от предположений; CI проходит на актуальной базе.
- **Зависимости:** до PR #2.
- **Статус:** PR #1 GitHub API пометил `merged=true` после integration merge; #6 включает connection report. `requirements-test.txt` в `main` сохраняет `shapely==2.1.2`; замена на `2.2.0` не вошла.
- **Контрольная точка:** после обновления PR-ветки/явного решения автора по уже имеющейся зависимости и повторной проверки на текущем main.

## Интеграция PR #2 — часть COORD-01

- **Исполнитель:** автор PR `@rinatikd`; точный агент-исполнитель по API не установлен (ветка `agent/codex-desktop/claude-collaboration`).
- **Проверяющий:** Claude-сгенерированный отчёт — комментарий [к PR #2](https://github.com/rinatikd/nss-engine/pull/2#issuecomment-6378274058), сделан на head `5e9b817badc67dd652167ba7639c1292a4215737`; формальных GitHub reviews и review threads — 0.
- **База и head:** PR сейчас нацелен на ветку PR #1 (`e95e0d4fd3ff4228e0d01ccbcef4a60214e57082`); head `d4d9c36728f33d9bfb18fec9915b2c5b0de388c5`. Текущий `main` — `40e4069fec420fe188cdfb38cc9cf2ee94aae603`.
- **Разрешённые файлы:** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/AGENT_COLLABORATION.md`, `docs/AGENT_DAILY_AUDIT.md`, `docs/CLAUDE_HANDOFF_TEMPLATE.md`, `docs/CURSOR_SETUP.md`, `docs/MULTI_AGENT_WORKFLOW.md`, `docs/PROVIDER_CONNECTION_CHECKS.md`, `docs/QWEN_ONBOARDING.md`, `docs/QWEN_REVIEW_01.md`, `docs/TASK_QUEUE.md`. `requirements-test.txt` и `docs/CODEX_DESKTOP_CONNECTION.md` входят в базовую ветку PR #1, а не в собственные 12 файлов PR #2.
- **Критерии:** общие правила и очередь верны для актуальной базы; статусы и возможности участников подтверждены; CI повторно проходит после обновления base; замечания ревью разрешены либо мотивированно закрыты.
- **Зависимости:** после решения по PR #1; затем отдельный интеграционный проход SEC-01.
- **Статус:** PR #2 закрыт как superseded PR #6; GitHub compare `main...agent/codex-desktop/claude-collaboration` показал `ahead_by=0`, весь head уже в `main`.
- **Контрольная точка:** после смены base на актуальный main, разрешения замечаний в текущих файлах и нового успешного CI.

## SEC-01 — парольные фразы в repo_guard

- **Исполнитель:** в отчёте ветки указан Codex приложения; личность исполнителя через PR/API не подтверждена.
- **Проверяющий:** Codex CLI, основной ПК (отдельная сессия и самостоятельный просмотр diff/тестов).
- **База и commit:** родитель `79a53fec612b80c1c6cf3afff6c39931f5939675`; commit `add8d053b534349fef190ba7de27be4590bac259` в `agent/codex-desktop/guard-passphrases`. Проверена применимость к нынешнему `main` `40e4069fec420fe188cdfb38cc9cf2ee94aae603`.
- **Разрешённые файлы:** `docs/GUARD_PASSPHRASES.md`, `tools/repo_guard.py`, `tools/test_repo_guard.py`, `tools/run_portable_checks.py`.
- **Критерии:** буквальная парольная фраза с пробелами блокируется и не выводится; placeholders и expression markers остаются разрешёнными по прежней политике; синтетические Git-тесты и portable suite проходят.
- **Зависимости:** проверено после PR #1/#2 в локальной интеграционной симуляции; текущий `main` уже имеет Shapely 2.1.2.
- **Статус:** `reviewed` локально, не `integrated`. Семь тестов SEC-01 прошли; на симулированной базе текущего `main` `repo_guard --staged` и `--tree HEAD` прошли, portable suite — 101 тест. Симуляция требовала разрешить конфликты PR #1/PR #2 и не меняла основной GitHub. PR для SEC-01 не найден; создать его доступными средствами нельзя. Ограничение: guard эвристический, проверяет известные шаблоны присваиваний/токенов, а не все возможные форматы секретов. Приватный fixture и AutoCAD/Revit не запускались.
- **Статус:** `integrated` в PR #6 / `main` `7d003ada368833f6a825eb2ebf2d43f8b676a064`; 7 targeted tests, full portable checks, local guard checks и PR CI run 37 успешны. Heuristic остаётся неполным детектором; CAD/BIM и private fixture не проверялись.

## CLAUDE-REV-01 — read-only ревью запуска NSS_CCTV_ANALYZE

- **Исполнитель:** Claude — предложен пользователем, но пока не получил задачу.
- **Проверяющий:** Codex CLI.
- **База:** `main` `40e4069fec420fe188cdfb38cc9cf2ee94aae603`.
- **Разрешённые файлы:** только чтение `work/NSS_TKK_Editor_v0.2/source/CctvCommands.cs`, `work/NSS_TKK_Editor_v0.2/modules/cctv/cctv_cli.py`, `work/NSS_TKK_Editor_v0.2/modules/cctv/cctv_core.py`, `work/NSS_TKK_Editor_v0.2/modules/cctv/test_cctv_core.py`.
- **Критерии:** для отмены, ошибок, дочернего Python, таймаутов и сохранности входных/выходных файлов указать точное место, условие, ожидаемое/наблюдаемое поведение, влияние и воспроизводимый синтетический пример; не менять файлы и не заявлять нативный AutoCAD запуск.
- **Зависимости:** доступный Claude канал без новой подписки/платного API.
- **Статус:** `blocked_access`, не отправлено и не принято. `claude.exe` версии `2.1.306` установлен, но `claude auth status` вернул `loggedIn=false`, `authMethod=none`; локальные окна/браузеры и прямой Claude-коннектор недоступны. Issue #3 относится к старому ревью PR, не к этой задаче.
- **Контрольная точка:** если появится уже авторизованный бесплатный Claude-канал; время неизвестно.

## DEEPSEEK-CCTV-01 — независимое ревью расчёта и тестов CCTV

- **Исполнитель:** DeepSeek — предложен пользователем, но пока не получил задачу.
- **Проверяющий:** Codex CLI.
- **База:** `main` `40e4069fec420fe188cdfb38cc9cf2ee94aae603`.
- **Разрешённые файлы:** только чтение `work/NSS_TKK_Editor_v0.2/modules/cctv/cctv_core.py` и `work/NSS_TKK_Editor_v0.2/modules/cctv/test_cctv_core.py`.
- **Критерии:** воспроизводимые замечания по единицам, численным границам и непокрытым сценариям; отделять доказанные дефекты от предположений; не менять исходники и не использовать инженерные чертежи.
- **Зависимости:** авторизованный канал DeepSeek без API-ключа, платной подписки или передачи чертежей.
- **Статус:** `blocked_access`, не отправлено и не принято. В доступных инструментах нет DeepSeek-коннектора/CLI, браузер и локальные приложения не обнаружены. Прошлый отчёт подключения описывает обычный чат без авторизованного GitHub, но в этой сессии он не перепроверялся.
- **Контрольная точка:** при появлении прямого read-only DeepSeek-канала без новых платных ресурсов; время неизвестно.

## Cursor — прежняя read-only проверка

- **Исполнитель:** Cursor; **проверяющий:** Codex CLI.
- **База из последней записи:** `main` `79a53fec612b80c1c6cf3afff6c39931f5939675`; актуальная база Cursor-клона не проверена.
- **Разрешённые файлы и prompt:** полный read-only prompt есть в `docs/CURSOR_SETUP.md:35-43`; он указывает `AGENTS.md`, `README.md`, `docs/SOURCE_MAP.md`, `docs/PORTABLE_SKILLS.md` и просит отчёт о Git origin/branch/SHA/status; не разрешает правки.
- **Критерий:** read-only отчёт о фактических origin/ветке/SHA, прочитанных правилах и навыках.
- **Зависимости:** фактический ответ Cursor и его проверяемая рабочая копия.
- **Статус:** по записи от 2026-10-24 ответ ожидался; сейчас `parked`, не считать активным назначением. Небольшую правку выбирать только после доступного канала и отчёта.
- **Контрольная точка:** после реального read-only ответа Cursor и проверки его базы; срок неизвестен.

## Другие участники

Для Grok, Gemini и Qwen в текущем цикле конкретные новые объекты ревью не назначены. Предыдущие проверки находятся в датированных отчётах PR #2; они не подтверждают текущий доступ или лимиты. Не создавать для них расписаний и задач ради активности.

## COORD-01 latest checkpoint (2026-10-24)

- GitHub Issue: #5. Latest successful fetch confirms `main` and `origin/main` at `40e4069fec420fe188cdfb38cc9cf2ee94aae603`; main working tree is clean.
- **Статус:** PR #1 GitHub API пометил `merged=true` после integration merge; #6 включает connection report. `requirements-test.txt` в `main` сохраняет `shapely==2.1.2`; замена на `2.2.0` не вошла.
- PR #2 remains open, unmerged, head `d4d9c36728f33d9bfb18fec9915b2c5b0de388c5`, based on PR #1 head `e95e0d4fd3ff4228e0d01ccbcef4a60214e57082`; its `clean` status is relative to that old base. Four documentation review corrections are included in candidate commit `01c7edafc39403602a571cb51d1b48d96e344291`; upstream PR #2 remains unchanged.
- SEC-01 `add8d053b534349fef190ba7de27be4590bac259` was reviewed and tested after the dependency/rules integration in a local simulation. The full portable suite reported 101 passing tests and repo_guard staged/tree passed before the later docs-only edits.
- PR #4 was found during the live refresh; it is a draft and outside COORD-01's permitted scope. No file assignment was made.
- Claude and DeepSeek tasks are blocked_access: no verified transmission/response channel is available in this session. No assignment is marked sent or accepted.
- PR #6 is open from `agent/codex-cli/coord-01-integrated-candidate` to `main` at base `40e4069fec420fe188cdfb38cc9cf2ee94aae603`. Verified head: `82439e60aca99729e4289a1d781bdefaa108969e`; GitHub reports `mergeable=true`, state `clean`; PR-triggered `Source checks` run 35 completed successfully. Independent read-only review found no blocking issue; no formal GitHub review is recorded. No merge has been performed.

## Independent review follow-up (2026-10-24)

A read-only internal Astra review of candidate `b5c16a8` confirmed the PR1 -> PR2 -> SEC-01 history and found no functional defect in the narrow SEC-01 guard change. It found three actionable consistency/coverage issues: the Cursor prompt was already available in `docs/CURSOR_SETUP.md` but TASK_QUEUE said it was unrecovered; queue and workflow used different lifecycle vocabularies; and `test_expression_marker_is_still_allowed` used `${ENVIRONMENT_VALUE}`, which matched the placeholder exemption before reaching the expression-marker branch.

Corrections: the queue now links to the exact read-only Cursor prompt and avoids claiming it was sent; both documents define aligned lifecycle states; `repo_guard.py` no longer classifies `${` as a placeholder token (the existing expression-marker rule handles it), and the test uses `${RUNTIME_CREDENTIAL}` so it reaches that rule. Verification on the updated candidate: 7 targeted repo_guard tests PASS, staged repo_guard PASS, full portable checks PASS, and diff check PASS. Native CAD/BIM and private fixtures remain untested.

## COORD-01 post-merge state (2026-10-24)

- PR #6 merged into `main` at `7d003ada368833f6a825eb2ebf2d43f8b676a064`; PR #1 merged, PR #2 closed as superseded by #6.
- SEC-01 `add8d053b534349fef190ba7de27be4590bac259` is integrated. `shapely==2.1.2` remains the main pin; PR #1 requested 2.2.0 but that upgrade was not adopted.
- GitHub CI `Source checks` run 37 passed before merge; local portable suite, 7 targeted repo_guard tests and repo_guard staged/tree passed. Native AutoCAD/Revit and private fixtures were not run.
- Claude and DeepSeek are still `blocked_access`; Cursor remains parked pending its read-only report. Their tasks were not sent in this session.

## Уточнение вторичного ПК после COORD-01: подтверждённые каналы

См. [PROVIDER_CAD_REVIEW_01.md](PROVIDER_CAD_REVIEW_01.md) и [отчёт Issue #5](https://github.com/rinatikd/nss-engine/issues/5#issuecomment-6380159920). Утверждения выше «не отправлены в этой сессии» относятся только к сессии CLI координатора. Их нельзя распространять на все ПК: Claude-CAD-01 и прежний пакет DEEPSEEK-CCTV-01 действительно переданы через браузер вторичного ПК, ответы получены и проверены локально. Глобальный blocked_access для этих проб устарел.

CLAUDE-REV-01 на базе40e4069 остаётся новым неотправленным назначением: не путать его с завершённым CLAUDE-CAD-01 на79a53fe. Для DeepSeek ID был переиспользован: завершённый пакет32b268e и предложенная проверка40e4069 — разные исполнения. Новую проверку не помечать sent/reviewed на основании старого ответа. Координатору сопоставить результаты и зафиксировать новый уникальный ID при необходимости свежего запуска. Обратная связь провайдерам ожидает отдельного согласия; никакого нового сообщения или write-назначения этим дополнением не отправлено.
