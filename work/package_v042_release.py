from pathlib import Path
import ast,hashlib,json,re,shutil,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_Engine_v0.42_Release'
def sha(f):
 with f.open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
latest=max((p/'validation_v042').glob('*/status.json'),key=lambda x:x.stat().st_mtime).parent
for f in (latest/'plugin').glob('*'):shutil.copy2(f,p/'Deploy'/f.name)
e=p/'Evidence/Release';e.mkdir(parents=True,exist_ok=True)
for f in latest.glob('*.log'):shutil.copy2(f,e/f.name)
shutil.copy2(latest/'status.json',e/'offline_status.json')
for name in ('recognition_release.log','final_checks.log','native_gui_attempt.log','native_gui_localtemp.log'):shutil.copy2(p/name,e/name)
commands={};inventory=[]
for directory in ('nss_engine','autocad','scripts','tests','contract_tests'):
 for f in sorted((p/directory).glob('*')):
  if not f.is_file() or f.suffix not in ('.py','.cs','.ps1','.csproj'):continue
  text=f.read_text(encoding='utf-8-sig');record=dict(file=f.relative_to(p).as_posix(),lines=len(text.splitlines()),sha256=sha(f))
  if f.suffix=='.py':
   tree=ast.parse(text);record['functions']=[x.name for x in ast.walk(tree) if isinstance(x,(ast.FunctionDef,ast.AsyncFunctionDef))];record['imports']=[ast.unparse(x) for x in ast.walk(tree) if isinstance(x,(ast.Import,ast.ImportFrom))]
  if f.suffix=='.cs':
   for cmd in re.findall(r'\[CommandMethod\("([A-Z0-9_]+)"',text):commands.setdefault(cmd,[]).append(record['file'])
  inventory.append(record)
old_commands=set()
for f in (root/'work/Handoff_v041/NSS_Engine_v0.41/autocad').glob('*.cs'):old_commands.update(re.findall(r'\[CommandMethod\("([A-Z0-9_]+)"',f.read_text(encoding='utf8')))
assert not(old_commands-set(commands)) and all(len(v)==1 for v in commands.values())
(e/'source_audit.json').write_text(json.dumps(dict(files=inventory,commands=commands,missing_legacy_commands=sorted(old_commands-set(commands)),duplicate_commands={k:v for k,v in commands.items() if len(v)>1}),ensure_ascii=False,indent=2),encoding='utf8')
recognition=json.loads((p/'RecognitionRelease/summary.json').read_text(encoding='utf8'))
table='\n'.join('| '+x['file']+' | '+str(sum(v for k,v in x['classifications'].items() if k!='unknown'))+' | '+str(x['screening']['segments'])+' | '+str(x['screening']['utilities'])+' | '+str(x['screening']['findings'])+' |' for x in recognition)
audit='''# Архитектурный аудит NSS Engine v0.41 → v0.42

Дата: 19.10.2026. Источник истины — CODEX_HANDOFF.md и NSS_Engine_v0.41_source.zip. Исходный архив и первая сборка v0.42 сохранены; дополнения выполнялись в work/NSS_Engine_v0.42_Release. Аудит охватил функциональные Python-модули, C#-адаптеры, скрипты, форматы JSON и тесты. Полный пофайловый индекс SHA-256, импортов, функций и зарегистрированных команд: Evidence/Release/source_audit.json. Это статический и тестовый аудит, не доказательство отсутствия ошибок во всех возможных чертежах.

## Слои и зависимости

```mermaid
flowchart LR
  A[AutoCAD DWG] --> B[Read-only C# exporters]
  B --> C[Versioned XYZ JSON 0.42]
  C --> D[Contract validation]
  D --> E[Explainable recognition]
  E --> F[Bounded XY screening]
  P[Engineer-supplied plan] --> G[A-star and weighted optimization]
  F --> H[Review report]
  G --> I[Preview JSON 0.31]
  I --> J[Shared preview validation]
  J --> K[Explicit engineer Yes]
  K --> L[NSS-owned non-plot preview]
```

C#-адаптер зависит от AcCoreMgd/AcDbMgd/AcMgd установленного AutoCAD 2026. TargetFramework=net8.0-windows, x64; Windows Desktop references устраняют реальные MSB3277. Autodesk DLL не копируются в комплект. Compile-time API проверено сборкой, runtime — отдельный неподтверждённый этап. Python-геометрия и маршрутизация в основном stdlib; ezdxf и его зависимости требуются офлайн DXF-аудиту. Отдельный C# console harness использует net10.0, тогда как плагин компилируется для .NET 8.

Историческая архитектура накапливает analyzer_v022..v025, snapshot_v022..v025, диагностику v034..v041. Есть дублирование обходов и несовпадающие контракты (XY X/Y в v022, XY x/y в v033, XYZ-массивы в v042). Новая версия не переписывает старые payload безусловно: новый strict XYZ контракт и явный адаптер pipeline_v042. Старые команды сохранены, дубликатов регистраций нет. Новая NSS_ANALYZE_V042 запускает Python без shell и без блокирующего ожидания, выводит путь задания; только terminal status подтверждает завершение. Worker сверяет имя/fingerprint чертежа, записывает исходный SHA и подробную ошибку.

## Подтверждённые дефекты и исправления

| Приоритет | Дефект | Результат |
|---|---|---|
| P1 | Очистка preview удаляла любую полилинию на префиксном слое | Удаляются только объекты с Xrecord-маркером собственности NSS; немаркированные и старые preview сохраняются |
| P1 | XYZ и дуги терялись в v033 | Новый V042 хранит XYZ/normal/bulge; V033 оставлен явной legacy-проекцией |
| P1 | Число ячеек длинной диагонали не ограничено | Лимиты ячеек и memberships, overflow fallback без потери bbox-кандидатов |
| P1 | Мост DWG→Python отсутствовал для нового контракта | NSS_ANALYZE_V042 + worker со статусами RUNNING/COMPLETED_REVIEW_REQUIRED/FAILED |
| P2 | v022 сначала выполнял квадратичный legacy duplicate scan | Legacy вызывается только для endpoint-диагностики |
| P2 | Soft-zone штраф считался по середине ребра | Точная длина объединения пересечений зон, без двойного счёта перекрытий |
| P2 | Абсолютный epsilon в A* отбрасывал маленькие улучшения стоимости | Удалены пороги 1e-9 при релаксации и проверке устаревших состояний |
| P2 | Python preview принимал ID, которые C# отвергал | Единая ASCII-грамматика, уникальность без регистра, общий лимит 20000 точек |
| P2 | Детали ошибок и контекст запуска терялись | Stack trace, exception chain, ErrorStatus, process/assembly version; единая папка NSS_REPORT_DIR |
| P2 | Диагностика падала на unhashable handle | Некорректный handle превращается в диагностическое замечание |
| P2 | Export helpers могли перезаписать входной JSON | Проверяется различие входного и выходного пути |
| P2 | Строгий JSON отвергал numpy bulge | Адаптер нормализует числовой тип в float; интеграционный DXF-тест |

Preview по-прежнему требует явного Yes. Вся запись выполняется одной транзакцией после проверки payload; при исключении Commit не достигается. Существующие пользовательские слои не перенастраиваются: plottable слой с совпадающим preview-именем вызывает отказ. Одноимённая немаркированная геометрия не удаляется. Проверка этих свойств в самом AutoCAD ещё не состоялась, офлайн проверен парсер и компиляция API.

## Математическая проверка

Топология: разворот дубликата и T-junction объединяются; пересечение внутренних частей не создаёт физическое соединение. Проверены пространственные кандидаты относительно полного bbox-эталона, в том числе при переполнении индекса. Проверка устранения скрытого квадратичного прохода считает фактические вызовы distance на 2000 объектах, а не измеряет нестабильное время.

Маршрутизация: A* сравнен с независимым BFS на 30 случайных решётках; взвешенная оптимизация — с независимым Дейкстрой без эвристики. Тонкие мягкие зоны учитываются, перекрытия не удваиваются. Это проверка концептуальной ортогональной модели, не доказательство оптимальности реальной строительной трассы. Пересечения и близость остаются геометрическими фактами/гипотезами, а не нормативным вердиктом.

## Известные границы

Автоматическая классификация — объяснимые предложения по точному слою, имени блока ККС и явным атрибутам NETWORK/SYSTEM/СЕТЬ. Противоречия дают unknown, каждый результат требует инженера. Это не обученная нейросеть. Слои инженер должен адаптировать; генплан вилл по умолчанию остаётся unknown. Только прямые WCS Z=0 входят в новый XY-adapter, bulge/ненулевой Z не уплощаются; вставки не создают физические узлы. По умолчанию анализ ограничен 1000 сегментами и явно перечисляет исключения.

Исходный cost/workflow_v030 продолжает считать условные стоимости по старому контракту и предупреждать о raw units: его нельзя использовать как подтверждённую смету. Объёмная геометрия, вложенные динамические блоки/Xref, проверенные нормы Казахстана, CRS и масштаб не решены в этом этапе. Нет измерения покрытия тестами и независимого инженерного эталона для всех четырёх реальных проектов. Старые PS1 сохранены, основной поддерживаемый запуск — Build-Validate-V042.cmd / scripts/build_validate_v042.py с фиксированным cwd.
'''
(p/'ARCHITECTURE_AUDIT_v0.42_RU.md').write_text(audit,encoding='utf8')
plan='''# v0.43 — план развития с проверяемыми воротами

1. Нативный runtime gate: восстановить обычный запуск AutoCAD 2026 вне ограничений текущего процесса, выполнить fixture NETLOAD/VALIDATE/EXPORT/ANALYZE и получить реальные JSON/DBMOD/логи. Пока это не выполнено, продукт нельзя считать проверенным в хосте.
2. Preview gate: на копии DWG проверить No/Yes, откат при исключении, UNDO, сохранность немаркированных объектов на одинаковых слоях; проверить очистку только owned Xrecord. Старые немаркированные preview удалять только вручную инженером.
3. Единый контракт планирования: явное подтверждение метров/CRS, fingerprint+свежесть snapshot, отказ от оценки стоимости raw units. Перевести legacy workflow по явной миграции, сохранив тесты.
4. Геометрия: аналитические дуги/3D в графе, явные пересечения и overlap без автоматической физической связи, provenance вложенных блоков, Xref без скрытого раскрытия.
5. Распознавание: редактируемые per-DWG mapping, очередь unknown/конфликтов, подтверждение инженером и регрессионные примеры для новых правил.
6. Эксплуатация: повторяемые сборки и нативные тесты на AutoCAD 2026/.NET 8, регрессионные лимиты больших файлов, CI и отчёт покрытия критических ветвей. Нормы Казахстана вводить только с проверяемыми источниками и применимостью.
'''
(p/'ROADMAP_v0.43_RU.md').write_text(plan,encoding='utf8')
checks='''# Планирование и code review v0.42

Применены запрошенные практики ECC: аудит границ модулей → список воспроизводимых дефектов → узкие исправления → функциональные и независимые эталонные тесты → повторная сборка → попытки нативного запуска → проверка комплекта. Отдельный ECC plugin/skill не устанавливался и не запускался.

Review: проверены read-only транзакции экспортов, отсутствие shell-интерполяции в Python bridge, фоновый callback без AutoCAD API, статусы завершения, входные лимиты, Z/bulge, ID/drawing binding, точность мягких зон и принадлежность удаляемого preview. Все существующие 199 тестов v041 сохранены; конечный набор включает 237 Python-тестов и 18 C# проверок. Успешные офлайн проверки не повышают статус AutoCAD runtime.

Нативные попытки не прошли: Core Console code 1, ошибка настройки профиля; GUI завершился с 0xC0000005 и сообщением о temporary directory. Повтор GUI с локальными TEMP/TMP не дал отчётов. Системные настройки/профили не менялись, процессы принудительно не завершались. На промежуточной DLL эти попытки не подтвердили NETLOAD; финальная DLL после добавления bridge скомпилирована, но не проверена в хосте.
'''
(p/'PLAN_AND_REVIEW_v0.42_RU.md').write_text(checks,encoding='utf8')
install='''# Установка и запуск NSS Engine v0.42 в AutoCAD 2026

1. Распаковать полный комплект в отдельную папку NSS_Engine_v0.42. DLL не переносить отдельно от runtime/nss_engine/scripts: Python bridge ищет их относительно папки сборки. Не заменять DLL в уже использующем её процессе AutoCAD.
2. Для повторной сборки из CMD: Build-Validate-V042.cmd. Нужны AutoCAD 2026 и установленный .NET SDK; отдельные C# tests сейчас требуют .NET 10, целевой плагин остаётся .NET 8. Скрипт не запускает AutoCAD, не меняет ExecutionPolicy, сохраняет unique validation_v042/<uuid> с logs/plugin/status.
3. В новом AutoCAD открыть только копию тестового DWG (либо копию RuntimeFixture/runtime_fixture_v042.dxf). NETLOAD → Deploy/NssEngine.Export.dll или DLL последней validation_v042. Ошибки NETLOAD и версию AutoCAD сохранить; успешная сборка не заменяет этот шаг.
4. Выполнить NSS_VALIDATE_V041 и NSS_EXPORT_V042. По умолчанию файлы — Documents/NSS_Engine; переменная окружения NSS_REPORT_DIR задаёт отдельную папку и должна быть установлена до запуска AutoCAD. Сверить XYZ/bulge/attributes/coverage и DBMOD до/после. Для fixture ожидаются 4 записи и один явный пропуск CIRCLE, а не полный охват.
5. NSS_ANALYZE_V042 → выбрать snapshot_v042_*.json текущего чертежа. DWG не изменяется, Python работает в фоне. В указанной analysis_<uuid>/status.json ждать COMPLETED_REVIEW_REQUIRED; RUNNING не считается успехом, FAILED содержит подробности/error.log. Имя и fingerprint текущего DWG проверяются. Нормативное соответствие и физические связи эта команда не подтверждает.
6. Старые NSS_EXPORT_V022/V033, NSS_HEALTH_V034, NSS_SELFTEST_V035, NSS_DIAG_V036, NSS_VALIDATE_V041 сохранены. V033 остаётся XY/hordes legacy. Новая цепочка XYZ не подаётся напрямую в старый workflow_v030.
7. Для маршрута — существующий offline workflow с явно подготовленным инженером plan, затем preview_v031 JSON. NSS_PREVIEW_V031 сначала валидирует payload и спрашивает Yes/No. No ничего не записывает. Yes добавляет только отдельную non-plot геометрию; исходная не редактируется. NSS_CLEAR_PREVIEW_V031 после подтверждения удаляет только объекты с меткой NSS. Старые preview без метки сохраняются намеренно.

## Автоматизированный read-only smoke (пока нативно не пройден)

Из PowerShell в корне распакованного комплекта:

```powershell
.\\runtime\\python.exe -X utf8 .\\scripts\\native_smoke_v042.py --prepare
.\\runtime\\python.exe -X utf8 .\\scripts\\native_smoke_v042.py --timeout 120
```

Первый только готовит копию fixture и SCR. Второй запускает новый процесс AutoCAD на этой копии, NETLOAD/VALIDATE/EXPORT, не делает QUIT/SAVE и не закрывает существующие процессы. Локальные TEMP/TMP меняются только для дочернего процесса. PASSED_READONLY_SMOKE возможен только после проверки JSON/XYZ/счётчиков/DBMOD/версии DLL/хэшей; это всё ещё не тест записи preview и не испытание реального проекта.

Если новые отчёты появились позже тайм-аута:

```powershell
.\\runtime\\python.exe -X utf8 .\\scripts\\native_smoke_v042.py --collect '<NativeTests/папка>'
```

Ручной анализ без AutoCAD:

```powershell
.\\runtime\\python.exe -m nss_engine.pipeline_v042 --snapshot '<snapshot.json>' --output '<новый анализ.json>'
```

--mapping принимает JSON точных слоёв в категории telecom/water/sewer/gas/heat/power/unknown. Полный нативный чеклист, включая No/Yes/UNDO/error rollback — VALIDATION_v0.42.md. Работа новой DLL внутри AutoCAD пока не подтверждена.
'''
(p/'INSTALL_AUTOCAD_2026_RU.md').write_text(install,encoding='utf8')
report='''# NSS Engine v0.42 — итог расширенного этапа, 19.10.2026

Исходный v0.41 сохранён. Продолжение выполнено в отдельной work/NSS_Engine_v0.42_Release, первая v0.42 также сохранена. Реализованы архитектурный аудит, совместимая компиляция, строгий XYZ контракт, распознавание по объяснимым признакам, Python bridge, ownership preview, точная экспозиция мягких зон, ограничение индекса и содержательные тесты. Пофайловый аудит и список дефектов — ARCHITECTURE_AUDIT_v0.42_RU.md.

## Фактические проверки

237 Python-тестов прошли (включая все 199 исходных), 18 C# контрактных проверок прошли. Финальная DLL net8.0-windows/x64 собрана с реальными AutoCAD 2026 managed reference DLL: 0 ошибок, 0 предупреждений. Runtime Windows Desktop dependencies включены в проект, Autodesk библиотеки не распространяются. Новые проверки покрывают независимые BFS/Дейкстра, точную union exposure, индекс против полного bbox-перебора, отсутствие скрытого quadratic legacy scan, распознавание конфликтов, отказ от потери Z/дуг, Python worker end-to-end и ошибку identity, совместимость preview и сохранность входных JSON.

Команды реально выполнялись из корня рабочей копии (build wrapper сам фиксирует cwd):

```text
runtime/python.exe -X utf8 scripts/build_validate_v042.py
dotnet run --project contract_tests/ContractTests.csproj -p:NuGetAudit=false -- contract_fixture_v042.json
runtime/python.exe -X utf8 -m unittest discover -s tests -v
dotnet build autocad/NssEngine.Export.csproj -c Release -o <unique plugin> "-p:AutoCADDir=C:\\Program Files\\Autodesk\\AutoCAD 2026" -p:NuGetAudit=false --nologo
runtime/python.exe -X utf8 scripts/native_smoke_v042.py --dll <intermediate DLL> --timeout 60
accoreconsole.exe /i <fixture_copy.dxf> /s <verify.scr> /l en-US
```

Офлайн распознавание и bounded screening повторены на всех entity JSONL четырёх DXF, созданных предыдущим проходом v042 (их source SHA остались неизменны). Эти повторные вызовы читают фактические записи, не выдают синтетическую выборку за нативный DWG. Полные результаты — RecognitionRelease, финальный журнал — Evidence/Release/recognition_release.log. Полный предыдущий геометрический аудит — Results_release_v042 и CHANGELOG_v0.42_ExportMilestone.md.

| DXF | Предложено категорий (не unknown) | Сегментов НСС в XY | Utilities | Замечаний |
|---|---:|---:|---:|---:|
'''+table+'''

NVK ограничен 1000 сегментами: 4010 геометрических записей исключены по бюджету, 727 — из-за Z, 16 — из-за кривизны; это частичный screening. Генплан вилл не содержит распознанных слоёв текущего словаря и остался unknown, а не «сети отсутствуют». В «Садик» и «Сети» также явно исключены вставки и ненулевой Z. Нулевые well_count в screening означают отказ от автоматического физического подключения по insertion point, не отсутствие колодцев.

## Нативный результат — не пройден

Core Console завершился code 1 с Problem with setting up current profile до получения отчётов. GUI acad.exe завершился code 3221225477 (0xC0000005), host.log: Cannot get temporary directory long path name. Повтор с локальным TEMP/TMP также завершился без отчётов. Нет подтверждения NETLOAD, нет новых JSON/DBMOD-результатов; причины нельзя приписывать самой DLL по этим данным. Попытки относятся к промежуточной сборке; финальная DLL после bridge и review не испытана в AutoCAD. Логи/SCR/копии fixture сохранены в NativeTests. Профили, registry и системные настройки не менялись, исходные DWG не открывались для записи, принудительное завершение пользовательских процессов не выполнялось.

Следовательно, комплект проверяем и скомпилирован, но называть его «реально проверенным стабильным плагином AutoCAD» пока нельзя. Нативные проверки загрузки/экспорта/фонового анализа/preview rollback должны пройти на рабочем сеансе пользователя по INSTALL_AUTOCAD_2026_RU.md и VALIDATION_v0.42.md. Маршруты остаются концептуальными, нормы Казахстана не добавлены без источников. Код legacy cost/raw units и 3D/Xref имеют ограничения из архитектурного отчёта.

Сохранены также сведения о предыдущем исправлении bulge numpy и трёх некорректных полилиниях. Независимой экспертной приёмки реальных сетей нет. NuGetAudit=false, сетевой аудит пакетов не проводился. План v0.43 — ROADMAP_v0.43_RU.md.

ZIP: исходники, тесты, runtime, Deploy DLL, инструкции, audit/roadmap, фактические отчёты и native failure evidence. CRC и manifest SHA-256 проверяются при упаковке; результат повторной сборки/тестов извлечённого архива — output/verification_v042_release.log. Это проверка комплекта, не AutoCAD runtime.
'''
shutil.copy2(p/'CHANGELOG_v0.42.md',p/'CHANGELOG_v0.42_ExportMilestone.md')
(p/'CHANGELOG_v0.42.md').write_text(report,encoding='utf8')
(p/'README.md').write_text('''# NSS Engine v0.42 — Release candidate

Полный исходный код C#/.NET 8 и Python, runtime, DLL и фактические проверки. Начните с INSTALL_AUTOCAD_2026_RU.md. Из CMD — Build-Validate-V042.cmd. Итог: 237 Python-тестов, 18 C# проверок, сборка 0 ошибок/предупреждений. Работа финальной DLL внутри AutoCAD не подтверждена; native startup attempts завершились без отчётов. Продукт пока release candidate, не инженерно принятый инструмент.

NSS_EXPORT_V042 → NSS_ANALYZE_V042: строгий XYZ snapshot, объяснимое распознавание, bounded screening, отчёт Python в фоне без записи DWG. Для маршрутизации сохранён legacy offline workflow с инженерным plan; preview требует Yes и создаёт только tagged non-plot объекты. Очистка не удаляет чужую геометрию. Полная XYZ topology, дуги/вложения/Xref и нормы требуют следующих этапов.

ARCHITECTURE_AUDIT_v0.42_RU.md — границы компонентов и ошибки; CHANGELOG_v0.42.md — фактические результаты; PLAN_AND_REVIEW_v0.42_RU.md — процесс проверки; ROADMAP_v0.43_RU.md — следующие проверяемые этапы. Evidence/Release содержит финальные логи, NativeTests — неуспешные нативные попытки, RecognitionRelease — фактический повтор на четырёх DXF. Дополнительные старые отчёты явно исторические.
''',encoding='utf8')
for name in ('ARCHITECTURE_AUDIT_v0.42_RU.md','INSTALL_AUTOCAD_2026_RU.md','ROADMAP_v0.43_RU.md','CHANGELOG_v0.42.md'):
 shutil.copy2(p/name,root/'output'/('Release_'+name))
skip={'obj','bin','__pycache__','validation_v042','RecognitionResults','temp'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and (len(f.relative_to(p).parts)>1 or f.suffix!='.log') and f.name!='MANIFEST_SHA256.json']
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_Engine_v0.42_Release.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f in sorted(files):z.write(f,'NSS_Engine_v0.42/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for n,d in manifest.items():assert hashlib.sha256(z.read('NSS_Engine_v0.42/'+n)).hexdigest()==d
 z.extractall(root/'output/NSS_Engine_v0.42_Release')
(root/'output/SHA256_v042_Release.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
print('Verified archive:',archive,archive.stat().st_size,'bytes; DLL SHA:',sha(p/'Deploy/NssEngine.Export.dll'))
