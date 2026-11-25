# Очередь совместной работы NSS

Обновлено: 2026-10-24, Asia/Qyzylorda. Этот срез очереди начат на main 48338c9a3d762dbda3a8a871e67e355929cc2c2e; перед созданием каждой новой ветки нужно fetch и записать её фактический SHA. Статусы: proposed — описано; ready — входы/канал проверены; sent — передано; accepted/acknowledged — исполнитель подтвердил; in_progress — начато; response_received — ответ получен, проверка может быть частичной; reviewed — проверено; integrated — в main. blocked_*, waiting_user, parked и rejected фиксируют состояние без утверждения о выполнении.

## COORD-01 — единая проверенная база

- Issue: [#5](https://github.com/rinatikd/nss-engine/issues/5).
- Исполнитель: Codex CLI, основной ПК / координатор.
- Проверяющий: владелец проекта; для SEC-01 и последующих кодовых задач проводилось отдельное read-only ревью.
- База и итог: начало — main 40e4069fec420fe188cdfb38cc9cf2ee94aae603; PR #6 — 7d003ada368833f6a825eb2ebf2d43f8b676a064; PR #7 — a6f6881e0a5b24d35aa5643eee583f3903d55ee1; PR #10 — 31848525631e6c326d7aac61eefe856ddfc9877c; PR #12 — 843d4ae631144f9f20adedd713854704af75ac46; PR #13 — 48338c9a3d762dbda3a8a871e67e355929cc2c2e.
- Разрешённые файлы: AGENTS.md, CLAUDE.md, GEMINI.md, docs/*.md; для SEC-01 — requirements-test.txt, tools/repo_guard.py, tools/test_repo_guard.py, tools/run_portable_checks.py и отчёт.
- Критерии: актуальные статусы PR/CI, независимое ревью SEC-01, полная очередь, реальные статусы участников, штатная интеграция, без секретов/платных ресурсов/пользовательских чертежей.
- Зависимости: последовательно PR #1 → PR #2 → SEC-01; затем очередь и отдельные CCTV задачи.
- Статус: integrated. PR #1 merged; PR #2 закрыт как superseded после подтверждения, что его head уже в main; SEC-01 включён через PR #6. Source checks run 37 прошёл; PR #7 и #10 получили успешные portable checks.
- Контрольная точка: очередь сверена с новым отчётом ниже; Issue не считается автоматическим запуском агента.

Пересечения: Claude и DeepSeek выполняли read-only ревью. CCTV-OUTPUT-01 и CCTV-CSV-01 интегрированы; активных write-назначений нет. Любую новую задачу назначать отдельным Issue; обработку malformed DXF назначать после согласования её контракта. Пустые камеры/стены не менять без контракта.

## PR #1 — зависимость тестов и отчёт подключения

- Исполнитель: автор PR @rinatikd; точный агент через API не установлен.
- Проверяющий: отчёт Claude в [комментарии PR #1](https://github.com/rinatikd/nss-engine/pull/1#issuecomment-6378273917); формальных GitHub reviews — 0.
- База / head: 79a53fec612b80c1c6cf3afff6c39931f5939675 / e95e0d4fd3ff4228e0d01ccbcef4a60214e57082.
- Разрешённые файлы: requirements-test.txt, docs/CODEX_DESKTOP_CONNECTION.md.
- Критерии: закрепить тестовую зависимость, отделить подтверждённые проверки от предположений, пройти CI.
- Зависимости: перед PR #2.
- Статус: integrated через PR #6. В main оставлен shapely==2.1.2; предложение о 2.2.0 не принято.
- Контрольная точка: выполнена.

## PR #2 — общие правила и очередь

- Исполнитель: автор PR @rinatikd; точный агент по API не установлен.
- Проверяющий: комментарий Claude к PR #2, сделанный на старом head 5e9b817badc67dd652167ba7639c1292a4215737; formal reviews/threads — 0.
- База / head: PR был основан на PR #1 head e95e0d4fd3ff4228e0d01ccbcef4a60214e57082; head d4d9c36728f33d9bfb18fec9915b2c5b0de388c5.
- Разрешённые файлы: AGENTS.md, CLAUDE.md, GEMINI.md, docs/AGENT_COLLABORATION.md, docs/AGENT_DAILY_AUDIT.md, docs/CLAUDE_HANDOFF_TEMPLATE.md, docs/CURSOR_SETUP.md, docs/MULTI_AGENT_WORKFLOW.md, docs/PROVIDER_CONNECTION_CHECKS.md, docs/QWEN_ONBOARDING.md, docs/QWEN_REVIEW_01.md, docs/TASK_QUEUE.md.
- Критерии: правила отражают проверенные каналы и базу; замечания разрешены; CI на актуальной базе успешен.
- Зависимости: после PR #1.
- Статус: PR #2 закрыт как superseded PR #6; compare показал ahead_by=0. Четыре замечания к документации исправлены до merge.
- Контрольная точка: выполнена.

## SEC-01 — парольные фразы в repo_guard

- Исполнитель: в отчёте ветки указан Codex приложения; личность API не подтверждена.
- Проверяющий: Codex CLI на основном ПК, отдельная read-only сессия.
- База / commit: родитель 79a53fec612b80c1c6cf3afff6c39931f5939675; add8d053b534349fef190ba7de27be4590bac259.
- Разрешённые файлы: docs/GUARD_PASSPHRASES.md, tools/repo_guard.py, tools/test_repo_guard.py, tools/run_portable_checks.py.
- Критерии: парольная фраза с пробелами блокируется без вывода; placeholders/expression markers сохраняют прежнее поведение; тесты проходят.
- Зависимости: после решения PR #1/#2.
- Статус: integrated через PR #6 в 7d003ada368833f6a825eb2ebf2d43f8b676a064; 7 targeted tests, portable suite, staged/tree guard и run 37 успешны. Guard остаётся эвристическим, не универсальным детектором.
- Контрольная точка: выполнена; AutoCAD/Revit и приватные fixtures не запускались.

## CLAUDE-CAD-01 / CLAUDE-REV-01 — ревью NSS_CCTV_ANALYZE

- Исполнитель: Claude через рабочий контекст Codex Desktop; прямая сессия в текущей среде не подтверждена.
- Проверяющий: Codex CLI; ответ в комментарии [COORD-01 #5](https://github.com/rinatikd/nss-engine/issues/5#issuecomment-6380159920), доступная статика проверена отдельно.
- База ответа: 79a53fec612b80c1c6cf3afff6c39931f5939675; текущая база 31848525631e6c326d7aac61eefe856ddfc9877c.
- Файлы по отчёту: CctvCommands.cs, TkkEditor.csproj, cctv_cli.py, связанные core/catalog. Полные локальные отчёт и fixtures со второго ПК недоступны.
- Критерии: отмена, ошибки, дочерний Python, таймауты, сохранность входов/выходов с точным местом и воспроизведением; статический анализ не равен запуску AutoCAD 2026.
- Зависимости: полный отчёт или повторная проверка текущего SHA; без платной подписки/API.
- Статус: response_received, полнота частичная. Краткое резюме указывало потерю старого DXF при сбое записи; подтверждено и исправлено CCTV-OUTPUT-01 (#8/#10). Остальные пункты не считаются независимо проверенными.
- Контрольная точка: полный разбор отмены/таймаутов/дочернего процесса; нативный хост отдельно.

## DEEPSEEK-CCTV-01 — ревью cctv_core.py и тестов

- Исполнитель: DeepSeek получил ограниченный пакет через Codex Desktop; запись/GitHub-доступ не подтверждены.
- Проверяющий: Codex CLI по резюме [COORD-01 #5](https://github.com/rinatikd/nss-engine/issues/5#issuecomment-6380159920).
- База пакета: 32b268e5325d49d94848cad030dfb798e4f705f3; текущая main — 31848525631e6c326d7aac61eefe856ddfc9877c.
- Файлы: read-only cctv_core.py, test_cctv_core.py, README; без чертежей. Полный локальный ответ здесь недоступен.
- Критерии: единицы, границы, непокрытые случаи; отделять факты от предположений.
- Зависимости: полный отчёт или повторное ревью текущего SHA без платных ресурсов.
- Статус: response_received, независимо проверена только часть резюме. Storage formula признана корректной, endpoint-ray finding отклонён; bulge/3D flags — ограничение парсера, политика reject/warn/approx не согласована и не считается дефектом.
- Контрольная точка: повторить аудит на текущем SHA или получить полный отчёт.

## Cursor — read-only проверка

- Исполнитель: Cursor; проверяющий: Codex CLI.
- База клона: неизвестна; последняя запись ссылалась на 79a53fec612b80c1c6cf3afff6c39931f5939675.
- Prompt и файлы: docs/CURSOR_SETUP.md:35-43; отчёт должен указать origin/ветку/SHA/status и прочитанные правила/навыки.
- Критерии: проверить фактическую базу и факт чтения без правок.
- Зависимости: ответ и проверяемая рабочая копия.
- Статус: parked; отчёт не получен, правка не назначалась.
- Контрольная точка: после отчёта; срок неизвестен.

## CCTV-OUTPUT-01 — атомарная запись результата CCTV

- Issue / PR: [#8](https://github.com/rinatikd/nss-engine/issues/8), [#10](https://github.com/rinatikd/nss-engine/pull/10).
- Исполнитель / проверяющий: Codex CLI; независимое read-only ревью /root/coord01_review.
- База / commit / интеграция: main a6f6881e0a5b24d35aa5643eee583f3903d55ee1; ветка 14e46b7726989b4e0e49a403952578447b8b44ec; итоговая main 31848525631e6c326d7aac61eefe856ddfc9877c.
- Разрешённые файлы: work/NSS_TKK_Editor_v0.2/modules/cctv/cctv_core.py, work/NSS_TKK_Editor_v0.2/modules/cctv/test_cctv_core.py.
- Критерии: не терять старый выход при ошибке; не публиковать частичный новый файл; удалять временный; успешный DXF и длинные допустимые имена сохраняются.
- Зависимости: замечание из read-only отчёта Claude/Codex Desktop; единственная write-задача на эти файлы в тот период.
- Статус: integrated; PR #10 CI 2/2 success; targeted CCTV 14 PASS, portable suite PASS, staged/tree guard и diff check PASS. Проверены частичный write failure, os.replace failure, Windows sharing violation, длинное имя и побайтовая совместимость. Issue #8 закрыта.
- Контрольная точка: выполнена; AutoCAD и приватные fixtures не проверялись.

## CCTV-CSV-01 — чтение CSV с UTF-8 BOM

- Issue: [#11](https://github.com/rinatikd/nss-engine/issues/11).
- Исполнитель / проверяющий: Codex CLI; независимое read-only ревью назначено /root/coord01_review.
- База задачи в Issue: main 31848525631e6c326d7aac61eefe856ddfc9877c; ветка фактически создана от main 843d4ae631144f9f20adedd713854704af75ac46.
- Разрешённые файлы: work/NSS_TKK_Editor_v0.2/modules/cctv/cctv_cli.py, work/NSS_TKK_Editor_v0.2/modules/cctv/test_cctv_core.py.
- Критерии: BOM и plain UTF-8 дают одинаковый результат; end-to-end synthetic test; не менять политику пустых камер/стен; portable suite и repo_guard проходят.
- Зависимости: после CCTV-OUTPUT-01; эти файлы не редактировать параллельно.
- Статус: integrated через PR #13; commit ветки 5c407462cff4559128c779c7c704af36ed5daebc; main после merge 48338c9a3d762dbda3a8a871e67e355929cc2c2e. Issue #11 закрыта. Baseline KeyError воспроизведён; BOM и plain UTF-8 дают идентичный результат.
- Контрольная точка: выполнена. PR #13 checks 2/2 portable success; targeted CCTV 15 PASS; portable suite, staged/tree guard и diff check PASS; независимое ревью без блокеров.

## Существующий PR #4 — типовой КПП, вне назначенной очереди

PR #4 остаётся draft из ветки claude/kpp-plan-generator на старой базе 79a53fec612b80c1c6cf3afff6c39931f5939675; live API показал два failed portable runs. Не обновлялся, не ревьюился, не объединялся. Исполнитель обозначен только веткой/описанием; проверяющий не назначен; инженерные допущения требуют подтверждения. Для продвижения нужна отдельная ограниченная задача.

## Дополнительные доказательства вторичного ПК

Подробности завершённых CLAUDE-CAD-01 и прежнего пакета DEEPSEEK-CCTV-01: [PROVIDER_CAD_REVIEW_01.md](PROVIDER_CAD_REVIEW_01.md), [первичный отчёт в Issue #5](https://github.com/rinatikd/nss-engine/issues/5#issuecomment-6380159920). Это прежние снимки79a53fe/32b268e, а не ревью текущего main. Атомарная запись и BOM с тех пор исправлены координатором — статусы соответствующих задач выше остаются определяющими. Текущие назначения координатора сохранены; новых поручений это дополнение не создаёт. Обратная связь внешним провайдерам по результатам локальной проверки всё ещё ожидает отдельного согласия пользователя.
