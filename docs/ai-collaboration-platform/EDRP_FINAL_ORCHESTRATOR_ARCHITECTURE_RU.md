# EDRP — целевая архитектура финального оркестратора

**Статус:** проект архитектуры для Раунда 2 Cross-Review; не утверждён и не развёрнут  
**Версия:** 0.1 / 22.11.2026  
**Пилот:** NSS Engine (AutoCAD 2026 / .NET 8), затем APS Expert и AGPT Plugin  
**Границы:** Windows 11, один инженерный ПК, локальные сервисы и интерактивные AI/AutoCAD-компоненты  
**Решение владельца:** Production — read-only; Lab — автономность в заранее утверждённых границах; GitHub — зеркало, не единственный источник истины

---

## 1. Резюме архитектурного решения

Рекомендуется не строить «маленький Kubernetes» и не внедрять полноценный кластер Temporal на одном рабочем ПК. Рекомендуется локальная платформа с одним системным Supervisor, отдельным интерактивным User Agent и небольшим Bootstrap-механизмом восстановления. Она использует лучшие идеи зрелых систем, но без их инфраструктурной цены:

1. **Kubernetes controller pattern:** каждый контроллер сравнивает Desired State с Observed State и сводит текущее состояние к желаемому. Контроллер отвечает только за свой набор ресурсов; повторное наблюдение — норма, а не авария. См. [Kubernetes Controllers](https://kubernetes.io/docs/concepts/architecture/controller/).
2. **Temporal Durable Execution:** последовательность действий и результаты записываются в Event History; после сбоя состояние реконструируется воспроизведением истории. Внешние побочные эффекты выполняются как отдельные Activity и не должны повторяться только потому, что Workflow был replayed. Для EDRP берём эти принципы, но не разворачиваем Temporal Server, если нет распределённых Workers/узлов и реальной потребности в его отдельной инфраструктуре. См. [Temporal Workflows](https://docs.temporal.io/workflows), [Durable Execution](https://docs.temporal.io/durable-execution), [Event History](https://docs.temporal.io/encyclopedia/event-history).
3. **Windows SCM:** Service Control Manager запускает и восстанавливает только системный Supervisor. SCM не должен конкурировать с внутренним оркестратором за перезапуск одних и тех же дочерних компонентов. Настройки failure actions должны включать ограниченный restart budget и reset interval, а не бесконечный restart loop. См. [SERVICE_FAILURE_ACTIONS](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa) и [Guidelines for Services](https://learn.microsoft.com/en-us/windows/win32/rstmgr/guidelines-for-services).
4. **Windows Job Objects:** дочерние процессы конкретной операции объединяются в Job Object для учёта, ограничения и контролируемого завершения. Job Object — механизм управления процессами, а не второй Supervisor и не источник Desired State. Флаг KILL_ON_JOB_CLOSE применяется только к краткоживущим worker-группам, когда завершение всех дочерних процессов при потере владельца действительно безопасно. См. [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
5. **SQLite WAL + журнал операций:** локальная БД — источник истины для активных задач, операций, lease, состояний, портов и транзакционного outbox. Для критических переходов — WAL и synchronous=FULL; WAL не переносится на сетевую файловую систему. См. [SQLite WAL](https://www.sqlite.org/wal.html) и [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).
6. **Intent → Apply → Verify → Commit:** система никогда не считает изменение успешным только потому, что команда была отправлена. Неясный исход внешнего действия становится UNKNOWN, блокирует повтор и требует reconcile/evidence. Exactly-once для произвольного внешнего эффекта не обещается.

**Главная рекомендация:** EDRP должна быть *однописательным локальным control plane с независимым User Agent, durable operation journal и fail-closed исполнительным шлюзом*. Мультиагентность строится над ним; AI-участники не получают произвольную власть над Windows.

## 2. Компоненты и границы ответственности

### 2.1. Компонентная схема

~~~mermaid
flowchart TB
  SCM["Windows SCM"] --> S["EDRP Supervisor Service"]
  BOOT["Bootstrap / Recovery mode"] --> S
  S --> DB[("SQLite WAL<br/>state + operations + events + outbox")]
  S --> GIT["Local Git / desired config"]
  S --> REC["Recovery Storage<br/>signed bundles + backups"]
  S --> EVD["Evidence Storage<br/>hash-addressed artifacts"]
  S --> PM["Port Allocation Manager"]
  S --> POL["Security Kernel / Policy Engine"]
  S --> JOB["Worker launcher / Job Objects"]
  JOB --> W1["NSS worker"]
  JOB --> W2["APS / AGPT workers"]
  JOB --> BR["Chrome Bridge host / MCP transport"]
  TASK["Task Scheduler<br/>logon / unlock"] --> UA["Interactive User Agent"]
  UA <--> S
  UA --> ACAD["AutoCAD 2026 / .NET 8"]
  UA --> CHROME["Chrome profile / extensions / AI tabs"]
  CHROME <--> BR
  AI["ChatGPT + Claude + expert agents"] --> ORCH["Consilium / EDRP task orchestration"]
  ORCH --> S
  POL --> JOB
  BR --> ORCH
~~~

### 2.2. EDRP Supervisor Service — единственный системный владелец жизненного цикла

Supervisor — Windows Service с минимальным набором привилегий. Он:

- загружает и проверяет Desired State, политику и manifest установленных компонентов;
- ведёт reconcile loops и планирует операции;
- владеет SQLite write lane, outbox, lease и реестром ресурсов;
- запускает и завершает worker-процессы через ограниченный launcher;
- контролирует сервисные endpoints, MCP, туннели и адаптеры;
- создаёт restore points до разрешённых изменений и проверяет rollback;
- формирует evidence pack каждого завершённого задания;
- не показывает UI, не управляет интерактивным окном AutoCAD и не вводит текст в AI-чаты.

Supervisor не должен иметь безусловный доступ к любому файлу/процессу. Все операции проходят через типизированные handlers и Policy Engine.

### 2.3. Bootstrap — режим восстановления, а не второй постоянно работающий менеджер

Три отдельных долгоживущих процесса (Bootstrap, Supervisor и Watchdog) создадут конкурирующие циклы восстановления. Поэтому Bootstrap должен быть максимально малым и запускаться только на ранних этапах загрузки или при подтверждённой неисправности Supervisor.

Предпочтительный вариант: подписанный Bootstrap executable или изолированный recovery mode в небольшом отдельном host, который умеет только:

- проверить подпись/хеш Supervisor и его конфигурации;
- восстановить заведомо проверенную предыдущую версию из Recovery Storage;
- восстановить минимальный runtime, если пакет доступен локально;
- записать неизменяемое событие восстановления;
- передать управление SCM.

Bootstrap **не** имеет права:
- управлять AI-сессиями и браузером;
- самостоятельно менять Production;
- менять allowlist, ACL, credentials или системную политику;
- убивать неизвестные процессы ради освобождения порта;
- одновременно запускать второй экземпляр Supervisor.

Bootstrap не должен «сам себя» восстанавливать по бесконечному кругу. Если проверенный rollback не удался, он останавливается в RECOVERY_REQUIRED и оставляет точную диагностику.

### 2.4. User Agent — единственный владелец интерактивной сессии

AutoCAD, Chrome, пользовательские диалоги, расширения и другие GUI-приложения относятся к интерактивной сессии пользователя. User Agent запускается Task Scheduler при входе и повторном входе пользователя, работает в его session, подключается к Supervisor по защищённому Named Pipe с ACL на конкретный SID.

Windows services работают в Session 0, отделённой от интерактивных пользовательских сессий; поэтому запускать AutoCAD и пытаться управлять его UI из Service — неверная граница. См. [Service Changes for Windows Vista — Session 0 Isolation](https://learn.microsoft.com/en-us/windows/win32/services/service-changes-for-windows-vista).

User Agent отвечает за:
- обнаружение фактического профиля Chrome и разрешённых AI-вкладок;
- безопасное взаимодействие с AutoCAD 2026 в активной сессии;
- read-only semantic health checks GUI-компонентов;
- отправку запросов к Supervisor и возврат evidence, но не выдачу себе новых полномочий;
- закрытие/обнуление сессионных leases при logout, browser restart, extension restart или смене epoch.

User Agent не является системным Supervisor. При выходе пользователя он может корректно завершиться; сервисная инфраструктура при этом продолжает работать.

### 2.5. Worker / Adapter

Любая операция, которая может зависнуть, завершиться ошибкой или породить дочерние процессы, выполняется в ограниченном Worker-процессе. У каждого Worker:
- идентификатор задания и operationId;
- конкретный capability set;
- рабочий каталог в allowlist;
- максимальный runtime, лимиты ресурсов и cancellation policy;
- отдельный stdout/stderr лог с redaction;
- Job Object и связь с событием Intent.

Для коротких workers Job Object можно настроить с KILL_ON_JOB_CLOSE, чтобы закрытие последнего handle не оставляло orphan children. Этот флаг нельзя автоматически применять к долгоживущим сервисам и процессам, которые должны переживать рестарт Supervisor. Ограничения и наследование Job Objects нужно проверять на реальных процессах, включая nested jobs и breakaway. См. [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) и [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

### 2.6. Разделение Council Plane и Transport Plane

- **Consilium / Orchestrator** — роли, задачи, раунды, решения, критерии приёмки, артефакты, evidence и синтез.
- **Chrome Bridge / ProviderTransport** — exact provider/tab/conversation binding, prepare/commit, single-writer lanes, fencing, revoke, delivery state.
- **Control Room** — UI и projection журнала; не самостоятельный источник истины.

Никакие понятия «раунд», «назначение», «вердикт» не должны попадать в Chrome Bridge. И наоборот: Orchestrator не должен выполнять DOM-вызовы напрямую. Стороны общаются через версионированный контракт.

## 3. Durable orchestration и транзакционная модель

### 3.1. Где брать идеи Temporal

Temporal полезен тем, что сохраняет Event History, восстанавливает workflow state replay-ем и записывает результаты Activity так, чтобы повторное исполнение workflow не повторяло уже выполненные внешние шаги. Для локального EDRP достаточно внутреннего подмножества этой модели:
- детерминированная логика планирования;
- отдельные Activities/Workers для I/O и внешних эффектов;
- сохранение результатов операции до продолжения workflow;
- стабильные requestId/operationId;
- lease, timeout, retry policy и manual intervention state;
- проверка истории при startup/recovery.

Не нужно копировать сам Temporal runtime, если платформа остаётся на одном Windows-хосте и не имеет нескольких независимых Worker nodes. Если в будущем появятся несколько машин, десятки долгоживущих распределённых workflows или внешние очереди, тогда повторно оценить Temporal. У Temporal есть service deployment cost, network dependency, versioning/migration concerns и дополнительная operational surface, которая сейчас не оправдана.

### 3.2. SQLite как операционная БД

**SQLite** — источник истины для изменяемого runtime state. Предлагаемые таблицы:

| Таблица | Назначение |
|---|---|
| desired_resources | желаемое состояние сервисов/плагинов/туннелей и версия manifest |
| observed_resources | последнее наблюдаемое состояние + время и источник evidence |
| operations | операции и их state machine |
| events | append-only события, actor, hash, previousHash, timestamp |
| outbox | зафиксированные intent, ожидающие dispatch |
| leases | право одного worker/controller на ресурс и epoch |
| ports | port claims, intended listener, owner identity, health |
| artifacts | content hashes, paths, source commit, provenance |
| approvals | owner approvals, exact scope hash, expiry, single-use nonce |
| checkpoints | backup IDs, snapshots, migration and recovery cursors |

Рекомендуемая конфигурация: journal_mode=WAL, synchronous=FULL, foreign keys ON, busy timeout, единый writer actor и короткие транзакции. WAL позволяет читателям не блокировать writer, но все процессы, использующие БД, должны работать на одном хосте; SQLite WAL не предназначен для сетевого filesystem. synchronous=NORMAL в WAL остаётся согласованным при сбоях, но может потерять последнюю committed транзакцию при power loss; для approval, Intent и operation state использовать FULL. См. [SQLite WAL](https://www.sqlite.org/wal.html) и [PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).

Нельзя держать SQLite-транзакцию открытой во время долгой сборки, network call или работы AutoCAD. Вместо этого:

1. короткая транзакция создаёт operation + intent + outbox;
2. worker lease claims operation;
3. внешний эффект происходит вне DB transaction;
4. worker сохраняет observed result/evidence;
5. короткая транзакция фиксирует verified outcome или UNKNOWN.

### 3.3. Append-only события

Не следует одновременно поддерживать два независимых источника истины — JSONL event ledger и SQLite state database. Это создаёт проблему dual-write: один storage может принять событие, а другой — нет.

Рекомендуется SQLite как транзакционный журнал и state store; immutable export в NDJSON/JSONL для аудита и переноса. Событие хранит:
- sequence;
- eventId;
- timestamp;
- authenticated actor / execution identity;
- type, operationId, taskId, roundId;
- sourceCommit, branch, artifact hash;
- payload schema version;
- previous hash + event hash;
- evidence reference.

Хэш-цепочка обнаруживает случайную модификацию и нарушение порядка, но не защищает от администратора, имеющего право переписать саму БД и пересчитать цепочку. Для повышенной защиты нужны подпись/внешний checkpoint (отдельный ключ, TPM-backed key или внешний evidence vault) и off-host export.

### 3.4. State machine для каждой операции

~~~mermaid
stateDiagram-v2
  [*] --> PLANNED
  PLANNED --> APPROVAL_REQUIRED
  PLANNED --> READY
  APPROVAL_REQUIRED --> READY: exact approval
  APPROVAL_REQUIRED --> BLOCKED: denied / expired
  READY --> INTENT_COMMITTED
  INTENT_COMMITTED --> APPLYING
  APPLYING --> APPLIED
  APPLYING --> UNKNOWN: acknowledgement lost / crash window
  APPLYING --> FAILED: explicit no effect
  APPLIED --> VERIFYING
  VERIFYING --> VERIFIED
  VERIFYING --> UNKNOWN
  VERIFYING --> ROLLBACK_REQUIRED
  ROLLBACK_REQUIRED --> ROLLING_BACK
  ROLLING_BACK --> ROLLED_BACK
  ROLLING_BACK --> UNKNOWN
  VERIFIED --> COMMITTED
  UNKNOWN --> RECONCILING
  RECONCILING --> VERIFIED
  RECONCILING --> FAILED
  RECONCILING --> MANUAL_REVIEW
~~~

Критически важное правило: UNKNOWN — не синоним ошибки и не разрешение повторить команду. Это признак, что действие могло произойти, но подтверждение потеряно. Операция:
- сохраняет исходный requestId;
- удерживает resource lock/fence;
- блокирует новый запрос, конфликтующий по тому же ресурсу;
- выполняет только read-only reconciliation/status query;
- при отсутствии доказательства остаётся MANUAL_REVIEW.

### 3.5. Idempotency и exactly-once

Не обещать exactly-once для внешних систем, которые не поддерживают транзакционный idempotency key. Для локальных файловых операций можно получить идемпотентность через exact content hash и atomic replace; для HTTP/API и browser click нужно опираться на idempotency contract сервера или классифицировать неопределённый результат как UNKNOWN.

Повтор разрешён только когда:
- подтверждено NOT_PERFORMED, или
- операция гарантированно идемпотентна и имеет тот же scope/operationId, или
- отдельная reconciliation процедура доказывает, что внешнего эффекта не было.

Для Chrome Bridge: prepare не нажимает Send; commit выполняет один click под актуальным fencing token; потерянный ACK переводит запрос в UNKNOWN, а не в повторную отправку.

## 4. Desired State, Controllers и Reconciliation

Каждый контроллер обслуживает ограниченную область:
- ServiceController — системные сервисы;
- ProcessController — worker-группы;
- TunnelController — сетевые тоннели и их endpoint;
- McpController — MCP readiness, tool registry и protocol handshake;
- PluginController — версия плагина, DLL/bundle, загрузка и command registration в AutoCAD;
- PortController — claims и конфликт listener;
- RecoveryController — snapshots, rollback и restore.

Контроллер не должен создавать бесконечную цепочку взаимных restart requests. Все действия проходят через единый Resource Lease/Operation coordinator и общий restart budget.

Состояние ресурса разделяется на:
- **Desired:** версия, настройки, запуск, требуемые capabilities, endpoint, hash;
- **Observed:** PID, process start time, executable path/hash, listener, health, actual version, last evidence;
- **Policy:** что разрешено сделать автоматически;
- **Evidence:** почему Observed state принят как истинный.

Контроллер запускает действие только при расхождении Desired и Observed, валидном lease и пройденных preconditions. Наличие PID или открытого порта само по себе не означает HEALTHY. Проверка должна пройти protocol handshake и semantic operation, например не просто TCP 200, а tools/list, browser_status, provider_status, для AutoCAD — реальный command registration/smoke test.

## 5. Запуск и восстановление в Windows

### 5.1. Кто имеет право перезапускать кого

| Объект | Владелец lifecycle | Механизм |
|---|---|---|
| EDRP Supervisor | SCM | Windows Service recovery actions с bounded retry |
| Bootstrap/recovery utility | SCM failure command или ручной recovery trigger | одноразовый запуск, отдельная проверка подписи |
| NSS/APS/AGPT workers | Supervisor | operation journal + Job Object |
| User Agent | Task Scheduler | logon / unlock triggers, пользовательская сессия |
| AutoCAD | User Agent / пользователь | интерактивный lifecycle, не SCM |
| Chrome Bridge | Supervisor для host процесса; User Agent/extension для профиля | transport health + browser epoch |
| AI provider tabs | User Agent + Bridge | exact origin/tab/conversation leases |

Запрещено настраивать SCM и Task Scheduler одновременно на бесконечный restart одного и того же Supervisor executable; или разрешать User Agent и Supervisor одновременно «исправлять» один и тот же worker. На каждый ресурс один владелец и один source of desired state.

### 5.2. SCM failure actions

Для Supervisor применить небольшой restart budget, reset period и backoff, после превышения — остановка с диагностическим событием и переход в recovery required. Операция RUN_COMMAND для Bootstrap допускается только как отдельная ограниченная recovery action и должна иметь собственную блокировку/nonce, чтобы не порождать петлю. Не включать автоперезагрузку ПК для обычных ошибок.

Microsoft указывает, что SCM считает число отказов в пределах reset period; при превышении числа заданных действий повторяется последнее действие. Это необходимо учитывать при проектировании backoff и restart loops. См. [SERVICE_FAILURE_ACTIONS](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa).

### 5.3. Холодный запуск

1. Windows SCM запускает Supervisor.
2. Supervisor проверяет executable signature/hash, config schema, source commit, DB и last event hash.
3. Startup recovery обрабатывает незакрытые операции: локальные атомарные операции reconcile по файлам; внешние — UNKNOWN/status query, без retry.
4. Bootstrap используется только если Supervisor отсутствует/повреждён/не проходит проверку.
5. Supervisor загружает Desired State, создаёт resource leases и поднимает только системные components.
6. Port Manager сверяет ожидаемые listener claims; unknown listener не убивается автоматически.
7. MCP/Bridge проходят semantic readiness gates.
8. При входе пользователя Task Scheduler запускает User Agent в его session.
9. User Agent проверяет профиль Chrome, AutoCAD version, открытый чертёж и плагин; GUI-only работы допускаются только после подтверждения соответствующей сессии.
10. Consilium становится RUNNING только когда Control Room восстановила журнал, Bridge поднял актуальную epoch, а готовые provider tabs прошли независимый preflight.

### 5.4. Повторный вход, logout и AutoCAD

При logout User Agent завершает интерактивные операции и отзывает сессионные leases. System Supervisor продолжает обслуживать сервисные зависимости. При новом login User Agent регистрируется заново и не считает прежние tabId/PID валидными — нужны новые process start time, tab binding, conversation ID и epoch.

## 6. Port Allocation Manager

Порты — часть Desired State, а не свободная переменная, которую можно случайно переприсвоить.

Рекомендуемые поля claim:
- componentId + component instance ID;
- configured port/range;
- address family and bind address;
- owner process identity (PID + process start time + executable path/hash);
- protocol/probe;
- endpoint consumers;
- scope (Production/Lab);
- epoch and lease expiry.

Правила:
1. Фиксированные endpoint (MCP, provider adapter, tunnel) сохраняют известный порт, если зависимые клиенты не умеют читать manifest.
2. Динамический порт разрешён только если endpoint атомарно публикуется в manifest, а все клиенты умеют его перечитать.
3. При конфликте сначала идентифицировать listener и его исполняемый файл; не завершать PID только по номеру порта.
4. Не использовать PID без process start time: PID может быть переиспользован.
5. Если обнаружен неизвестный владелец — PORT_CONFLICT_BLOCKED, а не kill/port-steal.
6. Изменение endpoint проходит staged update: подготовить новый listener, health-check, переключить клиентов, затем убрать старый listener с подтверждением.

## 7. Хранение, восстановление и секреты

| Хранилище | Источник истины | Что хранить | Что не хранить |
|---|---|---|---|
| Local Git | код + desired config | исходники, manifests, scripts, policies без секретов | пароли, bearer tokens, приватные ключи |
| SQLite | runtime state | operations, events, leases, outbox, observed state | большие бинарные файлы |
| Recovery Storage | проверенные restore points | подписанные bundles, known-good versions, manifests, backup DB snapshots | неизвестные архивы без provenance |
| Evidence Storage | доказательства | logs, test results, screenshots, signed hashes, reports | произвольные prompt dumps/секреты |
| Secret Store | credentials | DPAPI-protected credentials, certificate/TPM material, explicit recovery envelope | открытый .env, журналы с токенами |

DPAPI привязывает защиту к user/machine context; резервный план не должен предполагать, что один DPAPI blob восстановится после переустановки Windows или смены SID. Recovery policy должна явно включать: кто может восстановить секрет, где хранится recovery key, как проверить его доступность и как отозвать потерянные credentials. Нельзя просто экспортировать открытый токен в Git/backup.

### 7.1. Восстановление файлов

Для локальной NTFS-замены:
- построить новый файл во временном каталоге на том же volume;
- проверить schema, signature/hash, ACL и размер;
- закрыть handles;
- использовать ReplaceFile с backup исходного файла;
- повторно прочитать файл и проверить итоговый SHA256;
- commit operation только после verification.

Windows ReplaceFile может заменить файл с созданием резервной копии, но заменяемый/backup/replacement должны находиться на одном томе. MoveFileEx при переходе между томами может превратиться в copy+delete, то есть это не единый атомарный переход. См. [Moving and Replacing Files](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-and-replacing-files) и [ReplaceFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilea).

## 8. Security Kernel и AI agents

AI-агенты получают capability-limited инструменты, а не shell. Их ответ — недоверенные данные. Любой запрос проходит:
1. schema validation;
2. identity/role authentication;
3. capability check;
4. path/workspace/port/environment policy;
5. exact preconditions (hash, commit, epoch, resource lease);
6. approval check, если операция выходит за текущий уровень автономности;
7. execution через специализированный worker;
8. evidence collection;
9. policy post-check и journal commit.

Approval связывается с точным digest операции, path, environment, old/new SHA256, operationId, expiry и одноразовым nonce. Если план меняется хоть на один параметр, старое approval недействительно.

Supply-chain protections:
- pin SDK and packages; use lock files and hash/signature validation;
- build from known source commit and controlled environment;
- verify DLL signature/hash/provenance before loading;
- README, repository code, issue text, PDF, AI-generated patch, and MCP page content are all untrusted inputs;
- do not run postinstall scripts from unreviewed packages;
- keep Production configuration immutable to AI agents;
- no privilege escalation by passing actor, workspace or environment fields in a prompt.

## 9. Модель автономности

| Уровень | Разрешённые операции | Предусловия |
|---|---|---|
| A0 — Observe | status, read-only diagnostics, hashes, version, health | без изменений |
| A1 — Safe repair | restart ограниченного Lab worker, очистка истёкшего lease, повтор read-only probe | операция явно идемпотентна, restart budget |
| A2 — Reversible Lab | замена Lab файла/конфига, установка известного пакета, staging | backup + rollback plan + проверка hash |
| A3 — Verified Lab release | pull/checkout approved commit, build/test, publish Lab artifact | чистое рабочее дерево, точный commit, test gate, rollback rehearsal |
| A4 — Production | любой cutover, credential/ACL/port change, permanent service config | отдельное owner approval на exact digest + evidence pack |

Повышение автономности происходит не по заявлению модели, а после прохождения независимых fault-injection tests, rollback rehearsal, recovery tests и cross-review.

**Внешние ограничения остаются:** при отсутствии интернета, API, авторизации, лицензии AutoCAD, пользовательского входа или нужного ключа нельзя гарантировать восстановление внешнего ресурса. Full Recovery — цель с уровнями R0–R4, а не безусловная гарантия при любом внешнем отказе.

## 10. R0–R4 recovery contract

- **R0 — Process:** обнаружить падение/зависание, безопасно перезапустить контролируемый worker.
- **R1 — Service:** восстановить состояние системной службы и её configured dependencies.
- **R2 — Component:** восстановить известную версию компонента, конфиг, порт и MCP contract из signed manifest.
- **R3 — Environment:** восстановить рабочий каталог/пакеты/проектный state из локальных проверенных snapshots.
- **R4 — Rebuild:** развёртывание с нуля из offline cache, подписанных bundles и документированного recovery envelope.

R4 нельзя считать пройденным, пока не проверено восстановление на отдельной тестовой Windows VM без интернета, без GitHub и без прежнего user profile. Восстановление secrets и лицензий отдельно фиксируется как external dependency.

## 11. Десять решений — независимая предварительная оценка

| № | Решение | Предварительный вердикт | Условия / коррекция |
|---:|---|---|---|
| 1 | Supervisor + Bootstrap + User Agent | Согласен с коррекцией | Один долгоживущий Supervisor; Bootstrap только recovery mode; User Agent — GUI/session owner |
| 2 | Windows Service + Job Objects | Согласен | SCM только для Supervisor; Job Objects для краткоживущих worker trees, не вместо SCM |
| 3 | Git + SQLite + Recovery + Evidence | Согласен | SQLite — единый runtime source; Event Journal внутри транзакции, не отдельный конкурирующий JSONL source |
| 4 | Full Recovery R0–R4 | Согласен с условиями | Каждый уровень имеет проверяемый acceptance; внешние ресурсы/секреты являются ограничениями |
| 5 | Intent → Apply → Verify → Commit | Согласен | Внешний side effect с потерянным ACK — UNKNOWN, а не повтор |
| 6 | Port Allocation Manager | Согласен | Конфликт неизвестного owner блокирует операцию; не steal port |
| 7 | AI + Security Kernel | Согласен | AI только структурированные планы; Security Kernel/worker policy независимо проверяют |
| 8 | SCM Recovery + Watchdog | Согласен с коррекцией | Один restart owner на ресурс; restart budgets, circuit breaker, no mutual watchdog loops |
| 9 | Control Room + Bridge separation | Согласен | Council plane не должен писать ложные SENT/DELIVERED статусы без transport evidence |
| 10 | Event ledger + artifact receipts | Согласен с коррекцией | Нужны подписанные checkpoints/receipt verification; hash chain не защита от локального администратора |

## 12. Конкретные замечания к текущему Consilium MVP / PR #131

Это source review по текущей ветке PR #131, а не проверка Windows deployment.

### 12.1. Что стоит сохранить

- роли двух co-operators и пяти equal participants;
- независимые reviews ChatGPT и Claude;
- отдельный Bridge transport plane и Council plane;
- append-only журнал и hash chain как полезный audit trail;
- стабильные request IDs;
- подготовка artifact manifest и recipient receipts;
- transport contract prepare/commit/status/stop/revoke/events;
- UNKNOWN quarantine, per-tab fencing и запрет auto-retry.

### 12.2. Блокирующие корректировки до Lab deployment

1. **Нет доказанного live dispatch path из Control Room.** Контракт и adapter source есть, но UI/MVP ещё не доказывает отправку через реальный Bridge и подтверждённый receipt.
2. **Delivery state нельзя принимать от произвольного AI actor.** API сообщения должен отделять request/analysis comment от transport outcome. SENT, DELIVERED, REPLIED и VERIFIED допускаются только от trust-bound adapter event с requestId, payload hash, origin/tab/conversation/epoch и проверяемым evidence reference.
3. **Не задавать Production endpoint по умолчанию.** Provider adapter не должен по умолчанию подключаться к 17381. Требовать явный Lab profile + exact loopback endpoint; Production endpoint должен быть отдельной конфигурацией, недоступной в Lab build.
4. **Не выводить journal HMAC key только из bearer token.** Смена bearer token не должна лишать возможности проверить исторический журнал; хранить отдельный versioned key, protected by DPAPI/TPM/recovery process.
5. **Stale lock recovery.** Текущий эксклюзивный lock-file fail-closed безопасен от двух writer, но после process kill может остаться старый lock. Нужна безопасная процедура идентификации владельца по PID + process start time + machine identity; не удалять lock по одному PID и не разрешать второму writer стартовать при ambiguity.
6. **Event retention/archival.** Жёсткий limit журнала должен сопровождаться snapshot/rotation policy, verification и retention. При переполнении система может fail closed, но должна объяснить, какой evidence export нужен для освобождения места.
7. **Provider status semantics.** Click evidence, observed UI response и confirmed delivery — разные уровни. Не выставлять DELIVERED/REPLIED без точной атрибуции события и привязки к исходному request.

### 12.3. Release gates

- Windows Lab deployment на exact commit и подписанном package manifest;
- ChatGPT и Claude независимо аутентифицируются как равные operators;
- пять участников независимо аутентифицируются с equal participant permissions;
- one real selected provider transaction: prepare/no-send inspection → explicit owner-approved commit → correlated click receipt → reply attribution;
- cross-tab, wrong-origin, wrong-conversation и stale-epoch tests;
- lost ACK после commit переводит в UNKNOWN; повтор не происходит;
- restart Bridge/extension/browser во время PREPARED/COMMIT и доказательство fencing;
- rollback and restore rehearsal;
- no Production port/credential/profile changes;
- независимый cross-review и owner approval exact commit.

## 13. План внедрения без преждевременного переписывания

**Phase 0 — Stabilize the local control plane**
- исправить PR #131 source findings;
- зафиксировать ProviderTransport v1;
- определить SQLite schema, WAL/FULL, event/outbox transaction;
- определить actor authentication/roles and signed approvals;
- добавить exact Lab endpoint policy.

**Phase 1 — One real Lab component**
- один компонент NSS Engine;
- Supervisor service prototype;
- one worker launcher + Job Object;
- semantic health checks;
- R0/R1 recovery and fault injection.

**Phase 2 — User Agent**
- Task Scheduler logon/unlock launch;
- named-pipe ACL and challenge handshake;
- Chrome bridge and AutoCAD command readiness checks;
- session lease invalidation on logout/restart/epoch change.

**Phase 3 — Transactional operations**
- stable operationId/requestId;
- SQLite outbox and reconciliation;
- staged file replacement/backup/rollback;
- UNKNOWN quarantine and no retry.

**Phase 4 — Restore and autonomy**
- R2/R3 restore from known-good bundles;
- offline cache;
- R4 rebuild in disposable VM;
- promote autonomy one level at a time.

**Phase 5 — Multi-project expansion**
- APS Expert and AGPT Plugin as separate resource domains;
- no shared mutable global workspace;
- project-specific policy and version manifest;
- independent cross-review and acceptance.

## 14. Cross-Review — вопросы участникам

Каждый участник должен отвечать независимо по одному и тому же immutable commit SHA и этому документу. До фиксации первого ответа не показывать другим участникам чужие выводы.

- **Claude:** критика модели Supervisor/Bootstrap/User Agent, recovery chain, SCM, User Agent и AutoCAD session.
- **DeepSeek:** adversarial review: race conditions, stale PID, lock recovery, transaction crash windows, restart loops.
- **Grok:** практическая реализация Windows Service, Job Objects, Task Scheduler и порт-реестра; конкретные API/классы/тесты.
- **Gemini:** threat model, prompt injection, supply chain, DPAPI/backup/restore и offline operation.
- **Qwen:** анализ хранения, SQLite schema, durability, migration/rotation и performance.
- **Kimi:** состязательная проверка всех архитектурных компромиссов, что избыточно/недоказано, и альтернативная минимальная архитектура.
- **ChatGPT:** независимый synthesis и проверка источников/контрактов.
- **Владелец:** утверждает consequential decisions и любые Production/security boundaries.

**Важное состояние dispatch:** этот документ подготавливает Раунд 2, но сам по себе не подтверждает доставку поручений внешним AI-моделям. Фактическая доставка отмечается только после Bridge requestId и подтверждённого receipt.

## 15. Windows acceptance test matrix

| ID | Испытание | Ожидаемый результат |
|---|---|---|
| W01 | cold boot, без login | Supervisor starts, service health OK; GUI/AutoCAD не запускается в Session 0 |
| W02 | user logon | User Agent starts once, binds SID/session |
| W03 | logout/logon | старые leases invalidated; User Agent starts anew |
| W04 | kill NSS worker | один controller restarts worker в пределах restart budget |
| W05 | kill Supervisor | SCM performs bounded restart; no second Supervisor writer |
| W06 | corrupt Supervisor binary | SCM restart fails closed; Bootstrap restores signed known-good package or RECOVERY_REQUIRED |
| W07 | stale PID / PID reuse | owner mismatch detected by start time/path; no wrong process kill |
| W08 | port occupied by unknown process | PORT_CONFLICT_BLOCKED; no kill/port steal |
| W09 | crash between intent and apply | intent remains, precondition checked before apply |
| W10 | crash after external click before ACK | UNKNOWN/quarantine; no second click |
| W11 | SQLite power failure | WAL + FULL recovery yields committed or rolled-back transaction, no ambiguous partial state |
| W12 | SQLite disk full | operation fails before side effect or becomes UNKNOWN if effect already started; evidence retained |
| W13 | stale DB lock / crashed writer | single-writer protection; controlled recovery by owner identity |
| W14 | no internet | local components restore from cache; external provider tasks become WAITING_FOR_EXTERNAL |
| W15 | broken user credentials | secret restore follows explicit recovery envelope; no secret exported to logs/Git |
| W16 | tampered package/manifest | signature/hash failure blocks install |
| W17 | malicious README or prompt injection | no policy/capability changes; tool plan rejected |
| W18 | restart storms | circuit breaker prevents unlimited respawns |
| W19 | Bridge epoch changes | all old provider leases/prepare tokens invalidated |
| W20 | Production endpoint accidentally selected in Lab | policy rejects before network dispatch |

## 16. Итоговый вердикт

**Принять:** single Supervisor; desired-state reconciliation; SQLite WAL/FULL transactional operation store; append-only evidence; User Agent for GUI; Job Objects for bounded workers; Intent/Apply/Verify/Commit; port ownership verification; AI capability boundary; R0–R4 with explicit external blockers.

**Изменить:** Bootstrap is recovery-only, not another always-on supervisor; event history and state share one transactional store; SCM only manages Supervisor; one lifecycle owner per resource; endpoint binding must be Lab-explicit; message delivery state must be evidence-backed.

**Отвергнуть:** arbitrary PowerShell from agents; multiple independent watchdogs; auto-kill unknown listeners; treating TCP reachability as semantic health; automatic retries after ambiguous provider sends; exactly-once promises; Production mutation under Lab lease; claiming R4 without an offline rebuild test.

**NO-GO for production:** until real Windows E2E, rollback, R0–R4 acceptance, independent cross-review and explicit owner approval are complete.

---

## References

- [Kubernetes Controllers — control loop and desired/current state](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Temporal Workflows — deterministic replay and Event History](https://docs.temporal.io/workflows)
- [Temporal Durable Execution](https://docs.temporal.io/durable-execution)
- [Temporal Event History](https://docs.temporal.io/encyclopedia/event-history)
- [SQLite WAL](https://www.sqlite.org/wal.html)
- [SQLite PRAGMA synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
- [Windows Session 0 Isolation](https://learn.microsoft.com/en-us/windows/win32/services/service-changes-for-windows-vista)
- [Windows Service Failure Actions](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa)
- [Moving and Replacing Files](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-and-replacing-files)
- [ReplaceFile](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilea)


## 17. Free AI Workbench — product surface, not a second orchestrator

### 17.1. Current verified baseline

PR #111 (Free AI Workbench P0 — architecture and offline task ledger, head 52937cd64752bc5d9faadee13dedbd9cc300fc6b) is a **design + offline prototype**, not an installed multi-agent Workbench. Its declared scope is a local task ledger; it does not implement live LLM calls, browser control, Bridge delivery, Git workspace operations, PowerShell Direct, shell execution or project builds. This boundary is correct and should remain explicit.

The README's local test example points to C:/Engineering/ChromeBridge-PowerShell-Direct-Validation, not the intended target C:/Engineering/Free-AI-Workbench. That path mismatch means no successful installation or E2E test in the target folder is proven.

### 17.2. Prototype findings

The current tools/free-ai-workbench/ledger.mjs is useful for prototyping task transitions, but it must not become the long-term runtime ledger without hardening:

1. **Unauthenticated actor identity.** Actor and role are event fields supplied by the caller. A task record that says actor=claude is not cryptographic proof that Claude wrote it.
2. **Stale lock after crash.** An O_EXCL lock is deleted in finally, but finally is not run after power loss or hard process termination. There is no safe owner identity (PID + process start time + process image + machine ID) or recovery state.
3. **No durable append barrier.** appendFileSync without fsync does not demonstrate that an acknowledged event survives power loss.
4. **Torn tail.** A partial last JSONL record can make the entire replay fail. No incomplete-tail quarantine, truncation to the last verified offset or recovery manifest exists.
5. **No idempotent request admission.** Stable request IDs and payload fingerprints are needed to distinguish an identical retry from a conflicting action or a second execution.
6. **Minimal regression coverage.** The current tests do not demonstrate concurrent writers, stale lock recovery, partial record recovery, disk-full/fsync failure, duplicate delivery, tamper evidence or backup restore.
7. **No deployment evidence.** There is no verified Git remote/worktree/commit in the target local folder and no Node test result from C:\Engineering\Free-AI-Workbench.

These are reasons to keep the prototype offline, not reasons to discard it.

### 17.3. Target relationship to EDRP

Free AI Workbench should be the **human-facing task/workspace UI and multi-agent discussion surface** on top of EDRP, not another control plane:

- Workbench owns task intake, task views, user-facing plans, agent discussion, review presentation, decisions and evidence navigation.
- EDRP owns authenticated actors, desired/observed state, operations, approvals, provider/worker execution, idempotency, retries, leases, event history and recovery.
- Chrome Bridge owns exact-origin/tab/conversation transport, fenced prepare/commit, provider receipts and UNKNOWN quarantine.
- Project workspaces (NSS, APS, AGPT) are separate resource scopes, each with its own repo, branch, build/test policy and evidence.
- Workbench must never write an authoritative SENT, DELIVERED, REPLIED, VERIFIED or COMMITTED status from its own UI or from an AI response. It may display the state only after reading the EDRP/Bridge evidence record.
- There must be one authoritative operation ID and one idempotency key across UI, Control Room, Bridge adapter and worker. A UI retry must not create a second provider action.

The PR #111 JSONL ledger may remain as an offline mock/export format, but it must not be a second writable production ledger after EDRP adopts SQLite transactions and a durable outbox. Importing prototype tasks into EDRP should be a one-time, schema-validated migration with source hashes and a receipt; it must not silently create new executions.

### 17.4. Workbench integration gates

1. Confirm the exact target folder, Git remote, branch, commit, clean/dirty status and file hashes using chat-approved read-only PowerShell diagnostics. No install/overwrite before this baseline exists.
2. Keep the current offline prototype isolated; no auto-dispatch and no shell/PowerShell tools.
3. Add authenticated actor identities and server-issued role claims; user-supplied actor/role fields are display metadata only.
4. Move authoritative task/operation state to the EDRP store; expose a typed API for task create/read/update, review submission, approval request, and evidence receipts.
5. Add requestId, idempotency key and payload hash to every mutation; reject duplicate or conflicting IDs.
6. Add crash recovery and fault-injection coverage for lock ownership, partial append, full disk, interrupted commit and restore.
7. Connect AI participants only after Bridge session authorization, per-provider preflight, exact recipient binding and an owner-approved challenge; ChatGPT and Claude remain equal co-operators.
8. Demonstrate a read-only end-to-end flow first: Workbench task → EDRP journal → review record → evidence view. Add provider dispatch only in a later gate after the STOP/revoke and session challenge E2E tests pass.
9. Keep Production endpoints, profiles and secrets outside the Workbench Lab build. The Lab build must not silently fall back to Production.

### 17.5. Acceptance states

| State | Meaning | Current evidence |
|---|---|---|
| PROTOTYPE_OFFLINE | Local mock ledger only; no provider/OS execution | PR #111 source |
| TARGET_FOLDER_VERIFIED | Exact local path, remote, branch and clean/dirty status captured | NOT VERIFIED; chat-approved request returned QUEUE_FULL |
| EDRP_API_CONNECTED | Workbench task UI reads/writes authenticated EDRP records | NOT IMPLEMENTED |
| READ_ONLY_COUNCIL_E2E | Task and independent reviews flow across UI/EDRP without provider send | NOT RUN |
| PROVIDER_SESSION_E2E | Explicit owner-approved session challenge, exact provider dispatch and correlated receipt | NOT RUN |
| LAB_RELEASE | Reproducible package, rollback and Windows Lab evidence | NOT RUN |
| PRODUCTION_RELEASE | Separate owner-approved cutover with evidence | NO-GO |

**Decision:** do not install or overwrite the target Workbench folder until its actual local state is verified. Do not add a second Supervisor, scheduler or writable task ledger. Keep the P0 prototype as a contained offline experiment and evolve it into an EDRP client only after the EDRP API and identity/authorization contract are stable.
