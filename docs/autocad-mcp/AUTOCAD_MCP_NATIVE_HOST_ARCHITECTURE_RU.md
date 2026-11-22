# Собственный AutoCAD MCP: архитектура нативного host adapter

Дата: 2026-11-22  
Статус: Draft / architecture baseline, не реализация и не разрешение на установку.  
Связанные задачи: NSS Engine issue #135; будущие интеграции APS Expert и NSS Engine.

## 1. Цель и принципиальное решение

Разработать собственный provider-neutral AutoCAD MCP, который предоставляет ИИ не произвольное управление AutoCAD, а ограниченный, типизированный и проверяемый API чертежа.

**Целевая схема:**

```text
Claude / ChatGPT / Qwen / DeepSeek / Kimi / Grok / Gemini
                         |
                    MCP protocol
                         |
              MCP Gateway / Tool Registry
          schemas, auth, policy, request journal
                         |
             authenticated loopback IPC/HTTP
                         |
             AutoCAD .NET Host Adapter
          bounded queue + main-thread dispatcher
                         |
          document session / revision / policy
                         |
           AutoCAD Managed .NET API / DB
          DocumentLock + Database.Transaction
                         |
                    DWG database
```

MCP transport и модельный оркестратор не должны выполнять CAD API. Все обращения к AutoCAD проходят через один нативный host adapter внутри `acad.exe`. ИИ-провайдеры не получают разные CAD capabilities: все семь используют один и тот же контракт, а доступ ограничивается policy/approval, а не названием модели.

## 2. Что взято из внешних проектов

### Claude: U-C4N / AutoCAD MCP Pro

Сильные идеи, которые стоит перенять как принципы:
- единый типизированный tool contract и capability map;
- COM STA сериализация, bounded retries только для подтверждённо неисполненных вызовов;
- tool allow/deny policy, read-only token scope, лимиты стоимости операций;
- path/command guards, запрет произвольных команд и опасных файлов;
- operation journal, idempotency keys, явное `unknown_commit` и reconcile вместо слепого повтора;
- bounded output, pagination, checkpoints и проверка фактического результата.

Не копировать как основу CAD execution: COM остаётся межпроцессным слоем, а rollback в COM имеет более слабую гарантию, чем реальная Database.Transaction. U-C4N сам фиксирует native .NET worker как отдельное решение, зависящее от измерений.

В чате Claude зафиксирована локальная установка `autocad-mcp-pro 1.7.0` в `C:\\Work\\AGPT_Plugin\\AGPT_Plugin\\Autocad-MCP` и успешный отдельный Python COM probe `GetActiveObject('AutoCAD.Application')`. Но Claude Desktop config в видимом логе не был сохранён/проверен: открытие файла конфигурации через %APPDATA% завершилось ошибкой отсутствующей папки; далее нет подтверждения `Settings → Developer → Edit Config`, статуса сервера RUNNING, MCP `tools/list` или вызова `system_about`. Запрос `system_about` был отправлен в браузерный `claude.ai` чат, у которого нет локальных MCP tools. Следовательно, доказана только COM attach, не end-to-end MCP интеграция. Upstream main U-C4N сейчас содержит более новую версию 1.8.0; локально подтверждена только 1.7.0.

### Qwen: FastMCP + pywin32 prototype

Полезные идеи: typed geometry tools, ограничение числовых параметров, health/doctor, сценарии приёмки, разделение Planner и Executor.

Обнаруженные проблемы в сгенерированном коде:
- используется `Document.StartUndoGroup/EndUndoGroup`; Autodesk документирует `StartUndoMark/EndUndoMark`;
- нет гарантированной сериализации всех COM-вызовов через один STA worker;
- нет стабильной привязки к document/session и revision fencing;
- нет durable request journal и безопасного разрешения unknown write outcomes;
- COM initialization не балансируется вызовом CoUninitialize.

Этот код не является безопасной основой для исполнения на рабочем DWG. В Qwen transcript PowerShell installer и server.py показаны как сгенерированный текст; нет захваченного результата запуска installer, успешных unit tests или live AutoCAD tests. В прототипе также есть `save_document()`, сохраняющий активный документ напрямую, и `delete_entity()` без отдельного write approval, no-overwrite/copy-only guard или durable outcome journal; `list_entities()` возвращает только limit/truncated без cursor/revision-bound pagination. Поэтому даже после исправления Undo API и COM threading его нельзя подключать к пользовательскому DWG.

### Native .NET precedent: codesknight/AutoCAD-MCP

Его экспериментальный bridge подтверждает применимость паттерна:
- HTTP request admission отдельно от CAD execution;
- ограниченная очередь и выполнение из AutoCAD main-thread Idle dispatcher;
- `DocumentLock`, `Database.Transaction`, document IDs и expected revision;
- request IDs, deduplication/conflict, explicit unknown outcome;
- writable scope ограничен bridge-created drawings;
- MCP gateway остаётся отдельно от CAD host.

В опубликованном отчёте 2026-11-18 описано 42 вызова MCP→HTTP→CAD на синтетических чертежах, но проект прямо называет .NET backend экспериментальным, неполным по миграции инструментов и не имеющим durable recovery across restart. Перенимаем архитектурные принципы, а не код и не заявления о production readiness.

Дополнительная важная оговорка: ADR U-C4N от 2026-11-03 откладывает native worker до 1.9.0 и разрешает строить его только при одном из двух заранее заданных условий: доказанное ускорение минимум 3× относительно COM bulk job на одинаковом 1,000-line workload либо доказанная невозможность обеспечить надёжный rollback через UNDO marks. Сам .NET spike в этом ADR не запускался, worker_spike.json и реальные timing evidence отсутствуют. Следовательно, этот ADR не доказывает ни преимущество .NET по скорости, ни успешность конкретной реализации. Он показывает правильный подход: заранее определить измеримые критерии, отдельно учитывать SECURELOAD/подпись/сборки под каждую AutoCAD release family и не объявлять native worker проверенным до реального AutoCAD E2E. Для нашего проекта главный аргумент за native host — не обещание скорости, а настоящая Database.Transaction, безопасная документная привязка и переиспользование C#/.NET инженерного кода APS/NSS; это тоже должно пройти измерения и fault tests.

## 2.1. OmniBridge MCP — выводы из ролика Claude и аудита исходников

Репозиторий: https://github.com/ayoubmep/omnibridge-mcp (MIT, ветка main; просмотрено 2026-11-23). Это не просто рекламный макет: README и `docs/status.md` описывают конкретные E2E проверки. При этом собственный статус проекта датирован 2026-11-15, версия 0.1.0, Python 3.12 / MCP SDK 2.3 — это заявление автора, не наша независимая репродукция.

### Что действительно интересно и подтверждено опубликованным отчётом

- Один MCP gateway публикует пять универсальных tools: `cad_apps`, `cad_skill`, `cad_read`, `cad_modify`, `cad_screenshot`. Вместо сотен жёстко заданных CAD-команд модель получает короткий скриптовый интерфейс и guide по API конкретной программы.
- Три способа интеграции: in-process socket bridge на главном потоке приложения; внешний runner для COM/API; специальные каналы Revit pyRevit Routes и Unreal remote execution.
- Общий core ставит работу в очередь и исполняет CAD/3D API на главном потоке приложения. Для in-app bridge есть localhost token, bounded text/request sizes, timeout и undo wrapper для modify.
- По `docs/status.md` автор сообщает E2E: AutoCAD 2024; Revit 2026; Archicad 29; Blender 5.2.4; Unreal 5.8; SOLIDWORKS 2025. Описан межпрограммный пример: контур из AutoCAD использован для создания 76 уровней, 76 плит и 602 стен в Revit; аналогичная башня создана в Blender и Unreal. Это гораздо более содержательная проверка, чем просто список из «28 поддерживаемых приложений».
- Важное ограничение: AutoCAD проверялся на версии 2024, не на нашей AutoCAD 2026. Остальные строки registry не означают E2E готовность: docs/status прямо перечисляет множество adapters как written but not run. HTTP transport также не проверен удалённым клиентом.

### Что не следует копировать без изменений

1. `cad_read` — не sandbox и не гарантия read-only. Он исполняет произвольный Python script в COM namespace; такой код технически способен менять чертёж. MCP annotation `readOnlyHint=True` — подсказка клиенту, а не enforcement на стороне сервера.
2. `cad_modify` полагается на то, что MCP-клиент спросит пользователя об approval. В самом сервере нет обязательного approval token / operation scope / независимой policy gate. Скрипт может выполнять любые действия, доступные COM API.
3. AutoCAD `wrap` только пытается вызвать `StartUndoMark/EndUndoMark`, проглатывая исключения. Это grouping для Undo, не транзакция и не гарантированный rollback. Если скрипт упал после частичных изменений, wrapper не выполняет компенсирующий UNDO.
4. В AutoCAD flavour document берётся из `ActiveDocument` при подключении, но `command()` и undo wrapper повторно обращаются к текущему `ActiveDocument`. При переключении активного чертежа между операциями возможно расхождение document scope; нет opaque document ID/revision fence.
5. COM runner вызывает `CoInitialize()` в отдельном helper process на каждый запрос; в показанном пути нет симметричного `CoUninitialize()`. COM message filter и retry полезны, но сами по себе не решают неизвестный результат после timeout/потери ответа.
6. Сценарии Python не sandboxed — это прямо признано upstream. Localhost token защищает in-app socket bridge, но HTTP MCP transport в README прямо указан без собственной аутентификации. Выносить такой HTTP endpoint в tunnel без дополнительной identity/authentication нельзя.
7. Один undo step — полезная UX-функция, но не atomic transaction. Undo mark не обеспечивает ACID и не возвращает побочные эффекты файлов, команд, xref или внешних приложений.

### Архитектурное решение для нашего проекта

**Перенять у OmniBridge универсальность orchestration layer и skill-driven scripting как исследовательский/экспертный режим; не перенимать unrestricted script execution как production security boundary.**

Наш план:
- Сохранить provider-neutral MCP gateway и единый registry capabilities для всех семи ИИ.
- Ввести два разных API-профиля: `SAFE_TYPED` (основной, типизированные операции, серверная policy enforcement) и `EXPERT_SCRIPT` (ограниченный диагностический режим на disposable DWG/копиях, отключён по умолчанию, каждое выполнение требует явного approval).
- Сохранить идею app-specific `cad_skill` как справочник API, единиц, рецептов и известных ограничений, но skills не дают разрешений и не заменяют валидацию.
- Для AutoCAD 2026 оставить наш .NET host adapter: Document/Database binding, CAD main-thread dispatch, DocumentLock, настоящая Database.Transaction, read-back evidence и durable request journal. OmniBridge COM runner может служить сравнительным baseline и compatibility adapter, не production authority.
- Для Revit/Blender/Unreal/Archicad позже добавить отдельные app adapters под единый межпрограммный workflow contract. Не обещать cross-app atomicity: каждый app operation получает собственный job/evidence; workflow engine управляет зависимостями, checkpoints и компенсационными действиями.
- До любого установки/подключения провести отдельный security review и disposable test. Сейчас OmniBridge не устанавливаем и не меняем пользовательскую конфигурацию.

Источники: https://github.com/ayoubmep/omnibridge-mcp/blob/main/README.md ; https://github.com/ayoubmep/omnibridge-mcp/blob/main/docs/status.md ; https://github.com/ayoubmep/omnibridge-mcp/blob/main/docs/protocol.md ; https://github.com/ayoubmep/omnibridge-mcp/blob/main/src/omnibridge/runners/com.py ; https://github.com/ayoubmep/omnibridge-mcp/blob/main/src/omnibridge/server.py

## 3. Контракты и идентичность

Каждый запрос должен содержать:

- `protocol_version`;
- `instance_id` — уникальная идентичность загруженного host adapter;
- `document_id` — opaque ID конкретного документа/сессии, не ObjectId и не Handle;
- `request_id` — заранее созданный клиентом стабильный ключ идемпотентности;
- `expected_revision` — обязательный для мутаций revision, увиденный при последнем чтении;
- `operation` и строго типизированный `args`;
- `approval_scope` для операций, которым требуется явное разрешение.

Ответ — единый envelope:
`protocol_version, instance_id, request_id, document_id, revision, status, result, error, evidence`.

Статусы: `queued`, `running`, `succeeded`, `failed`, `rejected`, `cancelled_before_start`, `outcome_unknown`, `requires_reconcile`.

Правила:
1. Один `request_id` + одинаковый canonical payload возвращает прежний job/result и не запускает повторную мутацию.
2. Тот же `request_id` с другим payload даёт `REQUEST_ID_CONFLICT`.
3. Потеря ответа после admission не означает, что операция не исполнилась. Клиент только опрашивает job/reconcile; автоматического повторного POST нет.
4. `instance_id` mismatch, неизвестный/закрытый `document_id` или устаревший revision блокируют запись до исполнения.
5. Revision должен учитывать изменения из UI/других плагинов настолько, насколько это возможно. Если полноту наблюдения нельзя доказать, API сообщает режим revision как best-effort и не заявляет строгую optimistic concurrency.

## 4. AutoCAD host execution model

### Потоки

- Network/MCP threads: только HTTP parsing, authentication, schema validation, admission, job status.
- CAD thread: единственное место, где разрешено обращаться к Managed AutoCAD API.
- Не использовать `Task.Run`, thread-pool или произвольный background thread для работы с Database/Document/Editor.
- CAD queue имеет конечную ёмкость, backpressure, request deadline, stop state и явный drain/cancel policy.
- При закрытии документа или остановке плагина новые jobs отклоняются; queued jobs отменяются до старта; running job не объявляется отменённым, пока CAD thread не подтвердил terminal outcome.

### Dispatch

Первый кандидат — безопасная очередь, обслуживаемая на AutoCAD main thread через проверенный command/Idle dispatch механизм. Для каждого запроса dispatcher:
1. подтверждает состояние instance и document session;
2. получает именно целевой Document, а не безусловно MdiActiveDocument;
3. берёт DocumentLock там, где этого требует контекст;
4. проверяет expected_revision и operation policy непосредственно перед транзакцией;
5. открывает Database.Transaction;
6. выполняет одну логическую операцию или batch;
7. Commit только после успешных postcondition checks; иначе Abort;
8. считывает фактическое состояние и формирует evidence/result;
9. закрывает lock/transaction в `finally` и публикует terminal job state.

Поведение во время modal dialogs, command prompts, document close, AutoCAD shutdown и idle starvation — отдельные обязательные fault tests. Если dispatcher не может получить подтверждённый outcome, возвращается `outcome_unknown`, а не ложный timeout-as-failure.

## 5. Transaction, batch и file semantics

- Один MCP mutation tool call = одна Database.Transaction, если операция поддерживается транзакционным API.
- Batch ограничен по размеру, числу объектов, времени и допустимым типам операций. Сначала validate all steps; затем одна transaction; любая ошибка — Abort всей транзакции.
- Не включать в обещание atomic batch действия с внешними файлами, plot, publish, xref, shell, COM/SendCommand или side effects за пределами текущей Database.
- Save/export — отдельная фаза: уникальное имя, запрет overwrite по умолчанию, временный файл, проверка файла и SHA-256, отдельная artifact record. Ошибка после начала file I/O = `outcome_unknown`, а не database rollback.
- После успешной транзакции обязательно read-back: entity count/handles/types/coordinates/properties, layer/style state и revision. Tool response сам по себе не является доказательством корректной геометрии.

## 6. Security model

Начальные defaults:
- loopback only (`127.0.0.1`), случайный токен не короче 256 бит, constant-time comparison, локальный ACL на файле токена;
- запрет CORS по умолчанию, строгая проверка Host/Origin, ограничение тела, rate/queue limits;
- отдельные read-only и write scopes; per-tool allowlist; explicit approval for destructive/high-impact actions;
- отсутствие arbitrary `SendCommand`, AutoLISP, shell, process launch, file-system browsing, reflection, plugin loading и unrestricted path arguments;
- paths только через контролируемые artifact directories; no traversal, UNC/device/ADS/reparse escape, no overwrite;
- content из DWG (текст, атрибуты, XData, имена блоков/слоёв, внешние ссылки) считается недоверенными данными и никогда не является инструкцией для модели/оркестратора;
- logs не содержат bearer tokens, API keys, полные приватные prompt payloads или DWG content без явного разрешения.

Стадии доступа:
1. `READ_ONLY` — default, разрешены health, capabilities, drawing snapshot, layers, bounded entity pages, selected properties.
2. `SANDBOX_WRITE` — только Bridge-created disposable drawings.
3. `APPROVED_WRITE` — конкретный документ + конкретный набор операций + revision + request scope + срок действия.
4. `PRODUCTION_WRITE` — отдельный gate; не входит в MVP.

## 7. MCP tool packs

### MVP read-only
- `system_health`, `system_capabilities`, `get_instance_status`;
- `list_documents`, `get_document_info`, `get_drawing_state`;
- `list_layers`, `list_blocks`, `list_styles`;
- `query_entities_page` с фильтрами, projection, cursor, hard limit и revision-bound cursor;
- `get_entity` для allowlisted entity types;
- `get_selection_snapshot` — только read-only и с явной политикой доступа к pickfirst selection.

### Controlled write (после MVP)
- `create_layer`;
- `create_line`, `create_circle`, `create_arc`, `create_polyline`;
- `create_text`, `create_mtext`, `create_dimension`;
- `insert_block` только из allowlisted block libraries;
- `update_entity` по typed patch с expected revision;
- `execute_atomic_batch` из ограниченного перечня transactional-safe operations.

### Не включать в первую версию
- произвольные AutoCAD commands/LISP;
- delete-many без отдельного approval;
- save/overwrite текущего пользовательского файла;
- plot/publish, external references, arbitrary file paths;
- запуск внешних программ и загрузку DLL.

## 8. AutoCAD version / .NET target gate

Не выбирать TargetFramework только по надписи AutoCAD 2026:
- AutoCAD 2026 до Update 1.1 включительно: .NET 8;
- AutoCAD 2026 Update 1.2 и более поздние: .NET 10 по текущей таблице Autodesk.

Перед созданием проекта надо получить точный Product Version/Update level установленного AutoCAD. Далее:
- build profile `net8.0-windows` или `net10.0-windows` по подтверждённой версии;
- AutoCAD managed references (`AcCoreMgd`, `AcDbMgd`, `AcMgd`) берутся из конкретной установки и Copy Local=false;
- CI может собирать контракт/host abstractions и fake dispatcher; настоящий CAD smoke выполняется только на disposable AutoCAD instance и DWG.
- Не пытаться одной DLL заявить совместимость с неподтверждёнными AutoCAD update families.

## 9. Интеграция APS Expert / NSS Engine

MCP host adapter остаётся generic и не знает нормативную логику APS/NSS. Доменные tool packs вызывают внутренние application services:
- APS Expert: схемы АПС/СС, устройства, шлейфы, кабельные линии, маркировки, проверки правил и нормативов СП/СН РК;
- NSS Engine: инженерные сети, колодцы/ККС, маршрутизация, пересечения, кабельные спецификации.

Доменные сервисы не должны напрямую регистрировать MCP tools и не должны зависеть от провайдера. Они возвращают typed result + provenance/evidence; host adapter выполняет только документные операции и проверку результата.

## 10. План реализации и критерии приёмки

| Gate | Результат | Критерий |
|---|---|---|
| A0 | Version baseline | AutoCAD product/update, .NET runtime/SDK и managed DLL версии подтверждены |
| A1 | Protocol contract | JSON schemas, version negotiation, error envelope, request/job identity, contract tests |
| A2 | Host skeleton | Load/unload, health, capabilities, bounded queue, no CAD API off main thread |
| A3 | Read-only MVP | instance/document binding, snapshot, bounded pagination, stable cursor, read-only auth |
| A4 | Document lifecycle | close/switch/shutdown, stale ID, revision observation and fault injection |
| A5 | Transaction writes | create layer/line/circle; commit/abort and read-back on disposable drawing |
| A6 | Batch and recovery | bounded atomic batch, idempotency, duplicate/conflict, lost response, unknown commit, stop/drain |
| A7 | Artifacts | no-overwrite save/export, SHA-256, reopen read-only, file/database boundary tests |
| A8 | Security review | negative tests, token/ACL, Host/Origin, path attacks, prompt injection in drawing text |
| A9 | APS/NSS packs | domain tools, engineering evidence and regression fixtures |

Definition of Done:
- no writes to user DWGs in A0–A5;
- no automatic replay of unknown write requests;
- every claimed PASS is tied to exact commit, exact AutoCAD build, disposable drawing ID, test output and cleanup evidence;
- no Production integration until A8 and explicit owner approval;
- no "production-ready" claim before A9 and real Windows/AutoCAD E2E.

## 11. Open questions for the design review

1. Exact AutoCAD 2026 update level: determines .NET 8 vs .NET 10.
2. Preferred MCP gateway implementation: C# SDK vs Python FastMCP adapter. CAD host remains C# either way.
3. Host dispatch mechanism: Application.Idle queue vs ExecuteInCommandContextAsync vs command-context dispatcher; select only after AutoCAD 2026 smoke/fault tests.
4. Whether first controlled write should be limited to Bridge-created document or to a copy created from a user-selected source.
5. Durable journal location and recovery policy, including how to reconcile jobs after AutoCAD process restart.

## References

- Autodesk .NET compatibility table: https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-Customization/files/GUID-A6C680F2-DE2E-418A-A182-E4884073338A.htm
- Autodesk target framework exercise: https://help.autodesk.com/cloudhelp/2026/CSY/OARX-DevGuide-Managed/files/GUID-E4C5C858-787F-4D35-B7FC-1F2CBA3D4966.htm
- Autodesk Managed .NET Transaction: https://help.autodesk.com/cloudhelp/2026/ENU/OARX-ManagedRefGuide/files/OARX-ManagedRefGuide-Autodesk_AutoCAD_DatabaseServices_Transaction.html
- Autodesk Document Lock: https://help.autodesk.com/cloudhelp/2026/ITA/OARX-DevGuide-Managed/files/GUID-A2CD7540-69C5-4085-BCE8-2A8ACE16BFDD.htm
- Autodesk ActiveX StartUndoMark: https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-ActiveX-Reference/files/GUID-7C669949-1327-4CFD-96CF-CE65EC38DAA8.htm
- Autodesk ActiveX EndUndoMark: https://help.autodesk.com/cloudhelp/2026/ENU/AutoCAD-ActiveX-Reference/files/GUID-EAC301EA-ABF7-42DE-AC8B-CD77BC77873F.htm
- U-C4N/Autocad-MCP: https://github.com/U-C4N/Autocad-MCP
- codesknight/AutoCAD-MCP: https://github.com/codesknight/AutoCAD-MCP
- ranvirw18/autocad-mcp-server: https://github.com/ranvirw18/autocad-mcp-server
