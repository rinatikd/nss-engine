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


## PR #138 — отдельная проверенная рабочая копия (2026-11-23)

Целевой исходник для staging: `d9f12c9912398d5d89d4b2fad9e3caad2e359ee0` — branch `feat/psdirect-per-job-workspace-approval-20261123`. Не переключать основной checkout и не выполнять reset.

1. Одноразовый helper `tools/powershell-direct/Prepare-PR138PinnedWorktree.ps1` запускается из отдельной папки `C:\Engineering` (вне Git checkout) через PowerShell Direct с workspace `C:\Engineering`. Сначала `-Mode Inspect`, затем после PASS — `-Mode Prepare`. Он проверяет основной checkout на точный base SHA `f58f44a52c569a4a45e3ffe025dc6d1f62beff58`, чистоту, origin, удалённый branch HEAD; затем делает отдельный detached worktree:
   `C:\Engineering\ChromeBridge-Recovery-Install-20261114\work\PowerShellDirect-PR138-d9f12c9-release-clean`.
2. Из нового worktree запустить `tools/powershell-direct/Prepare-EngineeringLabR2.ps1` сначала с `-Mode Inspect`, затем `-Mode Prepare`. Эта редакция читает detached `.git` pointer, проверяет общий Git config/origin и точный HEAD; требует чистое дерево и создаёт только `C:\Engineering\PowerShellDirect-Engineering-Lab-R2`. Действующие R1, supervisor 17486/18086, туннель и production не перезапускаются.
3. После подготовки выполнить реальный Windows Node 24 regression suite из R2: `workspace-policy.test.mjs`, `local_test_runner.test.mjs`, `local_job_service.test.mjs`, `engineering-runner.test.mjs`, `service.test.mjs`, `named-suites.test.mjs`, `engineering.test.mjs`. Каждый запуск — отдельное одобренное задание; затем сверить source hashes из `source-hashes.json`.

**Текущий статус:** source/CI PASS; pinned helper и R2 detached-worktree support включены в PR #138. Это ещё не означает, что helper уже скопирован на Work PC, worktree создан или R2 staged. До подтверждения всех Windows E2E результатов не переключать supervisor и не менять конфигурацию службы.
