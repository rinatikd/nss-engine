# PowerShell Direct — контролируемое переключение на Engineering MCP (PR #110)

Статус документа: **READY FOR REVIEW, NO-GO FOR EXECUTION**. Основан на фактических результатах Windows E2E, preflight и удалённой проверки ключа 14.11.2026. Данный документ **не является разрешением остановить production**.

## Подтверждённые факты

- Проверенный исходный супервизор: `C:\Engineering\ChromeBridge-PowerShell-Direct-Validation\tools\powershell-direct\stack-supervisor.mjs`, слушает `127.0.0.1:17486`. PID 28356 **на момент измерения**.
- Проверенный дочерний `tunnel-client.exe` исходного супервизора: PID 18236 **на момент измерения**, обслуживает `127.0.0.1:18086`, `/healthz=live`, `/readyz=ready` и успешный control-plane poll.
- В системе ещё три других `tunnel-client.exe`. **Никогда не останавливать все экземпляры по имени.**
- Изолированная подготовленная версия: `C:\Engineering\PowerShellDirect-Engineering-Lab-R1`.
- Новая модель требует только отдельный `PS_DIRECT_ENGINEERING_AUDIT_DIR`; список рабочих каталогов не настраивается и не загружается.
- Рабочий каталог задаётся в каждом запросе, канонизируется и показывается в локальной карточке подтверждения; статического списка папок нет.
- Изолированный аудит: `C:\Engineering\PowerShellDirect-Engineering-Audit-R1` (не Git checkout).
- Восстановительный DPAPI-файл: `%LOCALAPPDATA%\ChromeBridge-Recovery\control-plane.dpapi`. Файл имеется, расшифровывается текущим пользователем; независимый read-only `admin tunnels get` с этим ключом получил HTTP-успех и совпадение tunnel ID.
- Tunnel ID: `tunnel_6af7222489608191a79063530fc14929`. Это **существующий** туннель, не создавать дубликат.
- Исходные тесты: 29/29, подготовленная копия: 27/27, MCP smoke: PASS в обоих окружениях, локальный E2E операторского подтверждения: PASS.
- Последняя проверка `ReadyToDraftOperatorTransaction=true`; `AuthorizeShutdown=false`.

## Что должна делать транзакция переключения

1. **Проверка перед действием.** Повторить `Prepare-EngineeringCutover.ps1`, `Inspect-EngineeringCutoverDependencies.ps1`, `Test-ControlPlaneCredentialDoctor.ps1` и удалённый read-only `Test-ControlPlaneRemoteAuth.ps1`; остановиться при любом отклонении. Считать PID и путь текущего процесса заново; старые PID использовать только как исторические свидетельства.
2. **Проверить восстановление до остановки.** Исходный `Recover-PowerShellDirect.ps1 -Mode Restore` адресует исходный супервизор и умеет запускать его только когда `17486` свободен. Холодное восстановление ранее не испытывалось — не считать его гарантированным. Оператор остаётся у локальной консоли Windows.
3. **Зафиксировать план нового запуска без секрета.** Исполняемый файл `C:\Program Files\nodejs\node.exe`; скрипт `C:\Engineering\PowerShellDirect-Engineering-Lab-R1\tools\powershell-direct\stack-supervisor.mjs`; рабочий каталог `...\tools\powershell-direct`; переменные:
   - `PS_DIRECT_ALLOWED_ROOT=C:\Engineering`
   - `PS_DIRECT_TUNNEL_CLIENT=C:\Engineering\chrome-bridge\codex-handoff-output\direct-cli-v21\runtime\tunnel-client.exe`
   - `PS_DIRECT_ENGINEERING_WORKSPACES=C:\Engineering\ChromeBridge-Recovery-Install-20261114;C:\Engineering\PowerShellDirect-Engineering-Lab-R1`
   - `PS_DIRECT_ENGINEERING_AUDIT_DIR=C:\Engineering\PowerShellDirect-Engineering-Audit-R1`
   - `CONTROL_PLANE_API_KEY` — только из локально расшифрованного DPAPI, только в памяти дочернего процесса. Никогда не выводить в лог, аргументы или GitHub.
4. **Остановка под контролем оператора.** Должна быть отдельная локальная явная команда подтверждения. После неё завершать *только* проверенный супервизор и *только* его проверенный дочерний туннель; убедиться в освобождении **обоих** портов 17486 и 18086. Никаких `taskkill /IM node.exe`, `Stop-Process -Name tunnel-client` или групповых завершений.
5. **Запуск новой версии.** Однократный запуск из prepared stage с ограничениями выше. Никаких параллельных экземпляров на одном Tunnel ID. Проверить владельцев портов 17486 и 18086, одного дочернего tunnel-client, `/healthz`, `/readyz`, успешный poll и новые локальные `tools/list`.
6. **MCP discovery в ChatGPT.** Проверить, что connected plugin действительно объявляет `powershell_engineering_submit` и `powershell_engineering_status`. До этого считать переключение функционально незавершённым. Существующее разрешение ChatGPT должно оставаться в режиме **Always ask**, а локальное подтверждение инженерных команд — обязательным.
7. **Реальный тест из этого чата.** Вызвать `powershell_engineering_submit` с `operation=git-status` и точным workspace, подтвердить локально, получить `FINISHED` и `exitCode=0` через `powershell_engineering_status`. Затем проверить `DENIED` и блокировку повторного requestId.
8. **ROLLBACK при любом нарушении критериев.** Остановить только новый проверенный супервизор и принадлежащий ему туннель, убедиться что 17486 и 18086 свободны. Запустить **исходный** `Recover-PowerShellDirect.ps1 -Mode Restore` из локальной Windows-консоли. Проверить original owner, дочерний tunnel-client, health/ready/poll и фиксированный инструмент `powershell_chat_readonly` из ChatGPT. Если rollback не удался — сохранить остальные туннели и не предпринимать массовых остановок.

## Условия GO

Все проверенные исходники и audit path доступны, DPAPI ключ независимо авторизуется, явно согласована ограниченная остановка исходного супервизора и его дочернего туннеля, создан отдельный операторский исполняемый скрипт с **проверкой синтаксиса, проверкой идентичности PID и автоматически вызываемым rollback**, выполнена репетиция на изолированном процессе без изменения production. Только тогда допустим операторский запуск production-cutover.

## Условия NO-GO

Неполная идентичность PID/родителя, нестабильный health, иной владелец 17486/18086, нехватка rights, отсутствие DPAPI, отсутствие RemoteAuth, несовпадение хэшей, отсутствие доказанного rollback, невозможность локально подтвердить действия, новый MCP инструмент не появляется или ChatGPT не получает прямой ответ.

## Ограничение

Это **runbook**, не реализованный production switch. Текущий сервис и туннель остаются работающими. Нельзя интерпретировать проверенное `ReadyToDraftOperatorTransaction=true` как разрешение `AuthorizeShutdown=true`.


## Новая политика workspace (feature branch 2026-11-23)

Постоянные allowlist-переменные `PS_DIRECT_ALLOWED_ROOT`, `PS_DIRECT_ENGINEERING_WORKSPACES` и `PS_DIRECT_NAMED_SUITE_WORKSPACES` удаляются из запуска supervisor. Любой существующий локальный каталог, доступный текущей Windows-учётной записи по ACL, может быть выбран для конкретного задания. Перед показом запроса сервис разрешает его в canonical realpath, запрещает томовые корни, системные каталоги, UNC/device-пути и включает полученный `cwd` в SHA-256 плана. После локального Approve once тот же canonical path сверяется повторно. Это не разрешает произвольные команды, не отключает per-job approval и не даёт дополнительных прав файловой системе. Обновление не считать установленным до Windows E2E и проверки MCP discovery.




> **Актуальность — 25.11.2026: NO-GO, не запускать шаги 1–8 выше как инструкцию к действию.** Они отражают исторический срез 14.11.2026: в них указан старый путь supervisor `ChromeBridge-PowerShell-Direct-Validation`, прежний recovery helper и устаревшие переменные allowlist. Фактический R1, зафиксированный в последующей проверке 24.11, расположен в `C:\Engineering\PowerShellDirect-Engineering-Lab-R1`; корректный recovery helper — `tools/powershell-direct/Recover-EngineeringDirect.ps1`. Этот helper предназначен только для запуска R1, когда оба его порта свободны, а не для остановки. Старые PID и старую команду cutover нельзя использовать. `Invoke-EngineeringCutover.ps1 -Mode Cutover` остаётся NO-GO до отдельного исправления путей, graceful shutdown, durable journal и rollback rehearsal. В feature-ветке дополнительно установлен безусловный кодовый guard `CUTOVER_DISABLED_GRACEFUL_DRAIN_JOURNAL_ROLLBACK_REQUIRED`; даже CLI switches не разрешают остановку. Guard покрыт Node-регрессией, а Windows PowerShell 5.1 parser включён в CI.

## PR #138 — отдельная проверенная рабочая копия (актуализация 25.11.2026)

Выбранный runtime-кандидат для воспроизводимого staging: **`35e69e7e58c7e1b054a0771cabce07cc0c4108df`**. Это точный commit, по которому зафиксированы 110 Git-tracked files, hash/inventory проверки, staged MCP smoke и локальные результаты 61/61 по семи основным regression suites. Текущий PR branch может содержать более поздние commits с helper/runbook/CI изменениями; это не должно незаметно менять runtime-кандидат.

**Не использовать прежний pin `5f6837a8f99dd0db23f35ec84e1b4dc8c172886d`:** он на семь commits старше выбранного кандидата и не содержит последних изменений `service.mjs`/`local_job_service.mjs` для `SERVICE_STOPPED`.

### 1. Detached worktree — точный commit

Новая версия `Prepare-PR138PinnedWorktree.ps1` требует явный параметр `-CandidateCommit`. Helper проверяет, что:
- primary checkout остаётся на ожидаемой ветке, имеет правильный origin и чистое дерево;
- его HEAD и защищённый base commit находятся на одной ancestry chain;
- после fetch удалённой feature branch кандидат является её предком;
- кандидат является потомком защищённого base commit;
- detached worktree создан именно на переданном SHA и остаётся чистым.

Пример из локальной папки вне checkout:

```powershell
$CandidateCommit = '35e69e7e58c7e1b054a0771cabce07cc0c4108df'
$Helper = 'C:\Engineering\ChromeBridge-Recovery-Install-20261114\tools\powershell-direct\Prepare-PR138PinnedWorktree.ps1'

& $Helper -Mode Inspect -CandidateCommit $CandidateCommit
# Продолжать только при Result=PR138_WORKTREE_PREFLIGHT,
# CandidateCommit=$CandidateCommit, DestinationExists=False,
# FetchPerformed=False и WorktreeCreated=False.

& $Helper -Mode Prepare -CandidateCommit $CandidateCommit
# Продолжать только при Result=PR138_PINNED_WORKTREE_READY,
# CandidateSha=$CandidateCommit, WorktreeClean=True,
# ProductionChanged=False.
```

Worktree создаётся отдельно:
`C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\PowerShellDirect-PR138-pinned-release-clean`.
Основной checkout не переключается и не reset-ится.

### 2. R2 stage — не перезаписывать legacy directory

На 24.11 существовавший `C:\Engineering\PowerShellDirect-Engineering-Lab-R2` был read-only проинвентаризирован: 1,244 файла и manifest старого формата; он не соответствует 110 tracked files кандидата. Его нельзя очищать или использовать под новый stage. Скрипт `Prepare-EngineeringLabR2.ps1` в runtime commit `35e69e7` по умолчанию указывает именно этот старый путь и отказывает при его существовании. Поэтому **не запускать его Prepare с этим default target**.

Для кандидата уже зафиксирован отдельный stage:
`C:\Engineering\PowerShellDirect-Engineering-Lab-R2-PR138-35e69e7`.
По записи от 24.11 его 110 tracked files прошли пофайловую SHA-256 проверку, inventory/manifest, syntax и selected regression проверки. Перед дальнейшим использованием stage нужно подтверждать его manifest и source SHA относительно worktree `35e69e7`; не доверять одному лишь имени каталога. Если этот отдельный stage отсутствует или manifest не совпадает, staging остановить — сначала требуется отдельный helper с параметром уникального `StageDirectory`, без удаления или замены legacy R2.

### 3. Regression и smoke

Для commit `35e69e7` записаны результаты локального Windows run по отдельным одобренным jobs:
- `workspace-policy.test.mjs`: 5/5;
- `local_job_service.test.mjs`: 7/7;
- `engineering-runner.test.mjs`: 5/5;
- `local_mcp_dispatch.test.mjs`: 4/4;
- `service.test.mjs`: 19/19;
- `named-suites.test.mjs`: 6/6;
- `engineering.test.mjs`: 15/15.

Итого: **61/61 PASS**; независимые stage-integrity проверки: 2/2. Отдельный `local_test_runner.test.mjs` дал 16/18: обе ошибки `TRUSTED_EXECUTABLE_NOT_CONFIGURED` связаны с отсутствующим явным `PS_DIRECT_TRUSTED_PYTHON`; не задавать Python через PATH и не обходить эту проверку. Composite PowerShell rehearsal-wrapper вернул Node child exit code 1 без диагностического вывода и **не считается доказательством PASS**.

### 4. Cutover gate

Source CI для PR commit `35e69e7` прошёл три workflow: Source checks, AI collaboration protocol checks, CCTV CLI input/output guards. Это не заменяет on-device acceptance и не является разрешением на stop/start.

До cutover остаются блокеры:
- согласовать фактический путь и identity существующего R1 с `Prepare-EngineeringCutover.ps1`/`Invoke-EngineeringCutover.ps1` (в них остался исторический путь `ChromeBridge-PowerShell-Direct-Validation`);
- заменить ссылку на старый `Recover-PowerShellDirect.ps1` правильным R1 recovery helper;
- реализовать graceful drain и ожидание закрытия exact child process вместо немедленного `Stop-Process -Force`;
- добавить durable transaction journal с терминальной записью каждой фазы и идемпотентным recovery;
- испытать failure injection и подтверждённый rollback на изолированном окружении;
- закрыть вопрос с unique R2 stage path и повторно подтвердить manifest на реальном Work PC.

До закрытия этих пунктов: **не выполнять cutover, не останавливать R1 и не менять production Bridge 17381/17382, credentials или туннели**.
