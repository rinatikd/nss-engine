from pathlib import Path
import collections,hashlib,html,json,shutil,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_Engine_v0.42'
def sha(path):
 with path.open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
rows=json.loads((p/'Results_release_v042/summary.json').read_text(encoding='utf8'))
provenance=p/'Provenance';provenance.mkdir(exist_ok=True)
shutil.copy2(root/'work/Handoff_v041/CODEX_HANDOFF.md',provenance/'CODEX_HANDOFF.md')
(provenance/'INPUTS_SHA256.json').write_text(json.dumps({str(Path(r['source']).name):r['sha256'] for r in rows}|{'NSS_Engine_Codex_Handoff_v0.41.zip':sha(Path(r'C:\Users\r.dautbekov\Downloads\NSS_Engine_Codex_Handoff_v0.41.zip')),'NSS_Engine_v0.41_source.zip':sha(root/'work/Handoff_v041/NSS_Engine_v0.41_source.zip')},ensure_ascii=False,indent=2),encoding='utf8')
evidence=p/'Evidence';evidence.mkdir(exist_ok=True)
latest=max((p/'validation_v042').glob('*/status.json'),key=lambda f:f.stat().st_mtime).parent
for f in latest.glob('*.log'):shutil.copy2(f,evidence/f.name)
shutil.copy2(latest/'status.json',evidence/'offline_status.json')
for n in ('baseline_tests.log','baseline_build.log','analysis_release_v042.log','workflow_final_v042.log'):shutil.copy2(p/n,evidence/n)
deploy=p/'Deploy';deploy.mkdir(exist_ok=True)
for f in (latest/'plugin').glob('*'):shutil.copy2(f,deploy/f.name)
verified=[]
for directory in sorted((p/'Results_release_v042').iterdir()):
 if not directory.is_dir():continue
 from sys import path
 path.insert(0,str(p))
 from nss_engine.contract_v042 import validate_entity
 count=0
 for line in (directory/'entities.jsonl').open(encoding='utf8'):
  validate_entity(json.loads(line));count+=1
 summary=json.loads((directory/'summary.json').read_text(encoding='utf8'))
 assert count==summary['exported'] and sha(Path(summary['source']))==summary['sha256']
 verified.append({'file':Path(summary['source']).name,'validated_entity_records':count,'original_sha256_matches':True})
(evidence/'record_validation.json').write_text(json.dumps(verified,ensure_ascii=False,indent=2),encoding='utf8')
if not (p/'README_v041.md').exists():shutil.copy2(p/'README.md',p/'README_v041.md')
(p/'README.md').write_text('''# NSS Engine v0.42

Рабочая копия проекта из NSS_Engine_Codex_Handoff_v0.41.zip. Основной новый этап — проверяемый экспорт геометрии XYZ без потери Z и без замены дуг хордами. Исторические модули и команды сохранены. Подробности: CHANGELOG_v0.42.md, VALIDATION_v0.42.md и CONTRACT_v0.42.md.

В комплекте исходники C#/Python, тесты, скрипты, Python runtime, собранная DLL (Deploy), фактические журналы (Evidence), офлайн-аудит четырёх DXF (Results_release_v042) и маленький тестовый DXF (RuntimeFixture). Autodesk DLL и .NET SDK не включены.

**Фактически проверено:** 217 Python-тестов, 11 C# проверок, сборка net8.0-windows с AutoCAD 2026 reference DLL: 0 ошибок/предупреждений. **Работа DLL в AutoCAD не проверена.** Наличие Deploy не означает нативный успех.

Откройте CMD внутри NSS_Engine_v0.42, выполните `Build-Validate-V042.cmd`. Нужен .NET SDK 10 для отдельного консольного теста; плагин остаётся .NET 8. Путь AutoCAD по умолчанию C:\\Program Files\\Autodesk\\AutoCAD 2026. Ничего не запускается в AutoCAD автоматически.

Новая команда NSS_EXPORT_V042 выгружает LINE, LWPOLYLINE и INSERT. Окружности, ARC, SPLINE и прочие типы явно пропускаются. INSERT содержит точку, нормаль, имя и атрибуты, но не геометрию блока. Xref не разрешается. Полный охват не заявляется. Готовый JSON обрабатывается `runtime\\python.exe -m nss_engine.snapshot_v042 --input <snapshot.json> --output <новый отчёт.json>`.

NSS_EXPORT_V033 остаётся устаревшей XY-проекцией с хордовой аппроксимацией; для XYZ используйте V042. Старый README_v041.md и preflight_v038.json — исторические материалы, не текущие результаты.
''',encoding='utf8')
(p/'CONTRACT_v0.42.md').write_text('''# Контракт snapshot3d 0.42

Каноническое имя версии — schema_version (snake_case, как в существующей ветке). kind="snapshot3d". Совместимость с входами 0.22/0.33 не подразумевается: автоматического понижения XYZ до XY нет. Новый анализатор snapshot_v042 выдаёт количества и длины, не топологию, маршруты или нормативную оценку.

drawing: непустые id/name, insunits_code целое 0..24, coordinate_system="unverified". Нативный id — FingerprintGuid; идентификатор не подтверждает систему координат. INSUNITS — декларация файла, фактический масштаб требует проверки. producer/timestamp_utc — информация происхождения; нативный экспорт их записывает.

entities: до 1 000 000 записей с уникальными без учёта регистра handle, layer, type, vertices, bulges, closed, block_name, attributes, normal, is_xref. vertices — массив XYZ WCS, до 100000 вершин на объект. Все координаты конечные и |значение|<=1e12; булевы значения не числа. normal — конечный ненулевой вектор, не XY-заглушка для полилиний. Для полилиний вершины должны лежать в плоскости normal в относительном допуске 1e-9.

LINE: ровно две XYZ, bulges=[], closed=false. LWPOLYLINE: минимум две вершины, столько же конечных bulge (исходные значения, не хорды). Последний bulge используется только при closed=true. Его знак относится к плоскости normal. INSERT: одна XYZ WCS, bulges=[], closed=false, непустое имя, словарь строковых атрибутов с уникальными тегами без учёта регистра, is_xref. Вложения, поворот, масштаб, динамические состояния и массивы не превращаются в геометрию; MINSERT явно пропускается.

coverage: неотрицательные целые visited/exported/skipped; visited=exported+skipped, exported=len(entities); truncated и complete — bool; complete=(skipped==0 && !truncated). Это техническая полнота выгрузки, не инженерная готовность: даже complete=true не раскрывает INSERT/Xref. warnings — массив {handle,code,message}, все значения строки. Пропуски имеют OBJECT_EXPORT_FAILED/UNSUPPORTED_ENTITY, вставки — BLOCK_GEOMETRY_NOT_EXPANDED/XREF_UNRESOLVED; ограничения экспорта — EXPORT_LIMIT. Верхний лимит 25 секунд кооперативный, не прерывает отдельный зависший нативный вызов.

Длина LINE вычисляется в 3D. Для полилинии используются пространственная хорда и исходный bulge: chord*(|b|+1/|b|)*atan(|b|). Полилиния с ненулевым bulge и совпавшими концами не измеряется. INSERT длины не имеет. Перевод в метры доступен лишь для явно поддержанных кодов INSUNITS; неизвестные единицы дают null. Нулевой код никогда не принимается за метры. Система координат и физические соединения остаются неподтверждёнными.

Python: contract_v042.validate_snapshot / validate_entity. C#: SnapshotContractV042.ValidateSnapshotJson / Validate. Нативный экспорт проверяет каждую запись до добавления; итоговые поля coverage формируются из счётчиков. Общая структура проверяется консольным C# тестом, его сериализованный пример проверяется Python. Парсинг файла snapshot_v042 ограничен 256 МБ. Синтаксически корректный контракт может содержать частичный анализ и предупреждения.
''',encoding='utf8')
(p/'VALIDATION_v0.42.md').write_text('''# Проверка NSS v0.42 (Windows PowerShell)

Откройте PowerShell в распакованной NSS_Engine_v0.42. Команды ниже не требуют изменения ExecutionPolicy.

```powershell
.\\runtime\\python.exe -X utf8 .\\scripts\\build_validate_v042.py
```

Нужны установленный AutoCAD 2026 и .NET SDK 10 (консольные contract_tests), доступные reference packs .NET 8 Windows Desktop. Альтернатива — Build-Validate-V042.cmd. --autocad-dir задаёт иной путь. Скрипт работает из любого cwd, сохраняет журналы и DLL в уникальную validation_v042/<uuid>, при ошибке возвращает ненулевой код, не запускает AutoCAD. NuGetAudit=false: сетевой аудит пакетов не выполнен.

Для отдельных команд:

```powershell
dotnet run --project .\\contract_tests\\ContractTests.csproj -p:NuGetAudit=false -- contract_fixture_v042.json
.\\runtime\\python.exe -X utf8 -m unittest discover -s tests -v
dotnet build .\\autocad\\NssEngine.Export.csproj -c Release '-p:AutoCADDir=C:\\Program Files\\Autodesk\\AutoCAD 2026' -p:NuGetAudit=false
.\\runtime\\python.exe -X utf8 -m nss_engine.dxf_audit_v042 --out .\\Results_new 'C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\NVK-SS-stroystandart.info.dxf' 'C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\ГП_Виллы_06.10.26.dxf' 'C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\Садик НСС.dxf' 'C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\Сети НСС 30.09.26 temp.dxf'
```

Results_new должна отсутствовать. Там появятся summary.json и подпапки entities.jsonl/warnings.jsonl/summary.json. Это потоковый аудит доступных ModelSpace-типов, не нативный тест AutoCAD, не полный инвентарь.

## Нативный тест — пока НЕ ВЫПОЛНЕН

1. Сохранить нужные изменения и закрыть предыдущий тестовый AutoCAD. Новую сборку загружать в новый процесс. Работать только с копией: открыть RuntimeFixture/runtime_fixture_v042.dxf и сохранить отдельной runtime_fixture_v042.dwg в рабочей тестовой папке. Исходные четыре DXF не сохранять и не перезаписывать.
2. Через NETLOAD выбрать DLL из Deploy либо plugin последней validation_v042. Сохранить полный текст команды/ошибки загрузки, версию AutoCAD, SHA-256 DLL. Успех сборки отдельно не подтверждает загрузку.
3. Записать DBMOD. Выполнить NSS_VALIDATE_V041; проверить Documents/NSS_Engine/runtime_validation_v041.json модулем runtime_validation_v041. Ожидаемые счётчики маленького примера: lines=1, polylines=2, blocks=1, other=1, failed=0. Это ожидание, не полученный нативный результат.
4. Выполнить NSS_EXPORT_V042. Проверить новый snapshot_v042_*.json в Documents/NSS_Engine (или NSS_REPORT_DIR, если задана до запуска AutoCAD). Ожидаются 4 записи и 1 явный пропуск окружности; inventory complete=false. Вертикальная LINE должна сохранить Z=2..7 и длину 5; две полилинии — bulge ±1, наклонная — исходную normal и WCS-Z; INSERT — атрибут CODE=ККС-1. Снова проверить DBMOD: read-only команды не должны его менять.

```powershell
.\\runtime\\python.exe -m nss_engine.runtime_validation_v041 --input '<runtime_validation_v041.json>' --output '<новый check041.json>'
.\\runtime\\python.exe -m nss_engine.snapshot_v042 --input '<snapshot_v042.json>' --output '<новый check042.json>'
```

5. Для совместимости отдельно выполнить NSS_EXPORT_V033, сохранить его предупреждения: он всё ещё XY/хорды, не источник 3D-проверок. Сравнить handles/слои, учесть иные имена файла и схемы.
6. NSS_PREVIEW_V031: выбрать RuntimeFixture/preview_v031.json, сперва ответить No и убедиться, что DBMOD/геометрия не изменились. Затем Yes только на копии DWG; ожидать одну полилинию на NSS_PREVIEW_V031_fixture. Выполнить UNDO либо NSS_CLEAR_PREVIEW_V031 с подтверждением и проверить отсутствие preview-объектов. Отдельно проверить некорректный preview JSON: никаких частичных записей до успешной валидации/Commit. Эти действия пока не проверены.
7. Проверить пустой чертёж, неподдерживаемый объект, INSERT с Xref и ошибку пути вывода; собрать runtime_v035.jsonl и все JSON/текст команд. Транзакции read-only экспортов должны освобождаться и при исключениях. В случае ошибки не утверждать PASSED по наличию одного файла.

Встроенные документы не заменяют нативный запуск. Геометрические пересечения не подтверждают физическое соединение. Нормативы Казахстана в этом этапе не добавлялись и не верифицировались.
''',encoding='utf8')
table='\n'.join(f"| {Path(r['source']).name} | {r['visited']} | {r['exported']} | {r['skipped']} | {r['length_units']:.6f} |" for r in rows)
bad=[]
for f in (p/'Results_release_v042').glob('*/warnings.jsonl'):
 for line in f.open(encoding='utf8'):
  w=json.loads(line)
  if w['message']=='bulge with coincident endpoints':bad.append(f'{f.parent.name}: handle {w["handle"]}')
report='''# NSS Engine v0.42 — фактический отчёт 19.10.2026

Основная ветка: переданный пользователем NSS_Engine_Codex_Handoff_v0.41.zip (CRC проверен), внутри NSS_Engine_v0.41_source.zip и CODEX_HANDOFF.md. Архивы сохранены без изменения; распакованы в work/Handoff_v041, разработка — отдельная work/NSS_Engine_v0.42. Старые v0.23.x не выдаются за реализацию v0.41. Запрошенный NSS_RealDXF_v0.18_AnalysisAndAutoCAD.zip в текущей папке/подпапках не найден; его распаковка не выполнялась. Четыре исходных DXF сохранены, SHA-256 проверены до/после.

Новый этап: строгий контракт read-only XYZ экспорта AutoCAD→Python. NSS_EXPORT_V042 сохраняет LINE/LWPOLYLINE/INSERT с исходными handles/слоями, пространственными координатами, normal, bulge, атрибутами и декларацией INSUNITS. Вместо ложной прямой по дуге сохраняется параметр дуги. Ошибка отдельного объекта/атрибута локализуется в warning; Xref/вложенные блоки явно не раскрываются. Ограничены объекты, вершины, координаты и кооперативное время экспорта. JSON пишется через временный файл в уникальное имя. Транзакция открывает только ForRead и не делает Commit.

NSS_VALIDATE_V041 теперь изолирует системные исключения чтения, не пишет пустое предупреждение при известных единицах, добавляет drawing_id/coordinate_system/inventory_complete. Python-валидатор больше не принимает произвольную строку за единицы. NSS_EXPORT_V033 сохранён как устаревший XY-экспорт: добавлена изоляция ошибок, реальная декларация INSUNITS, предупреждение о потере Z и исправлен расчёт длины замыкающей дуги через параметры, с проверкой лимита до целочисленного преобразования.

В проекте v0.41 действительно выполнено 199 Python-тестов. Исходная сборка прошла с 3 предупреждениями MSB3277 о версиях зависимостей. Добавление Windows Desktop references (UseWPF/UseWindowsForms) и явных global usings устранило их без подавления предупреждений. Плагин остаётся net8.0-windows, версия сборки 0.42.0. Новая сборка: 0 ошибок, 0 предупреждений. Консольные C# проверки отдельно на установленном net10.0; Autodesk DLL не распространяются.

Фактически выполнены команды из корня рабочей копии:

```text
..\\py312\\Scripts\\python.exe -X utf8 -m unittest discover -s tests -v
dotnet build autocad/NssEngine.Export.csproj -c Release "-p:AutoCADDir=C:\\Program Files\\Autodesk\\AutoCAD 2026" -p:NuGetAudit=false --nologo
dotnet run --project contract_tests/ContractTests.csproj -p:NuGetAudit=false -- contract_fixture_v042.json
..\\py312\\Scripts\\python.exe -X utf8 scripts/build_validate_v042.py
..\\py312\\Scripts\\python.exe -X utf8 scripts/create_runtime_fixture_v042.py --out RuntimeFixture
..\\py312\\Scripts\\python.exe -X utf8 -m nss_engine.dxf_audit_v042 --out Results_release_v042 <четыре абсолютных пути DXF>
```

Полные пути входов и результаты — Evidence/analysis_release_v042.log, Results_release_v042/summary.json, Provenance/INPUTS_SHA256.json. При подготовке одна пробная команда --help из неверного cwd завершилась ModuleNotFoundError; рабочие команды выполнялись из корня проекта. Первые два прогона DXF выявили отказ bulge-значений NumPy из-за строгого числового контракта; адаптер исправлен на float и дополнен интеграционным тестом чтения реального DXF. Эти предварительные отчёты не включены как финальные.

Итог: 217 Python-тестов прошли (199 существующих +18 новых), 11 C# проверок прошли. Проверены XYZ вертикальной линии, дуги/замыкание/наклонная плоскость, NaN/Infinity/bool/огромные значения, границы координат, атрибуты/OCS, коллизия handles, согласованность coverage, неизвестные единицы, запрет смешивания схем, пообъектная изоляция и сохранность исходника, реальный ezdxf bulge и сериализация C#→Python. Это не 228 нативных AutoCAD-тестов: они офлайн. NuGetAudit отключён, сетевой аудит пакетов не выполнялся.

Результаты офлайн-аудита (экспортированные записи включают INSERT; длины — всего поддержанного линейного содержимого, не только НСС):

| DXF | Прочитано | Выгружено | Пропущено | Длина, ед. DXF |
|---|---:|---:|---:|---:|
'''+table+'''

Все четыре файла объявляют INSUNITS=4 (миллиметры). Это не независимая проверка масштаба. Основные пропуски — TEXT, MTEXT, POINT, ARC, CIRCLE, POLYLINE, HATCH и прочие типы вне нового контракта. Сохраняются warnings по каждому пропуску. Найдены три некорректные дуговые полилинии (совпавшие концы ненулевого bulge), целиком исключённые из длины:

'''+ '\n'.join('- '+x for x in bad)+'''

После последнего изменения границ/валидатора все выгруженные записи повторно провалидированы; количество записей и SHA исходников проверены (Evidence/record_validation.json). Круги и самостоятельные ARC не анализируются этим этапом; старые модули сохранены, но их полная маршрутизация/стоимость на этих DXF не запускалась.

Не проверено: NETLOAD новой DLL, NSS_VALIDATE_V041/NSS_EXPORT_V042/V033/PREVIEW_V031 в AutoCAD 2026, реальные Xref/повреждённые native-объекты/отмена через UI, неизменность DBMOD в хосте, корректность WCS для каждого реального чертежа и нормативная применимость. Офлайн reader не охватывает все native/proxy ModelSpace-типы, поэтому complete_drawing_coverage=false для всех. Это не полный анализ пересечений/связности сетей и не инженерная приёмка. Никаких новых нормативных утверждений не добавлено.

Выданные Deploy DLL и build logs подтверждают компиляцию, а не работу в AutoCAD. Нативный тест — следующий шаг по VALIDATION_v0.42.md на копии DWG. Архив комплектуется manifest SHA-256 и проверяется по CRC; проверка извлечённого комплекта сохраняется рядом в output/verification_v042.log.
'''
(p/'CHANGELOG_v0.42.md').write_text(report,encoding='utf8')
shutil.copy2(p/'CHANGELOG_v0.42.md',root/'output/CHANGELOG_v0.42.md')
shutil.copy2(p/'VALIDATION_v0.42.md',root/'output/VALIDATION_v0.42.md')
page='<!doctype html><meta charset="utf-8"><title>NSS v0.42 — офлайн-аудит</title><h1>NSS v0.42: офлайн-аудит четырёх DXF</h1><p>Полный охват чертежа и работа в AutoCAD не подтверждены. XYZ сохранены; блоки и Xref не раскрыты.</p><table border="1"><tr><th>Файл</th><th>Прочитано</th><th>Выгружено</th><th>Пропущено</th></tr>'
for r in rows:page+='<tr>'+''.join('<td>'+html.escape(str(v))+'</td>' for v in (Path(r['source']).name,r['visited'],r['exported'],r['skipped']))+'</tr>'
page+='</table><p>Подробности: summary.json и подпапки с entities.jsonl/warnings.jsonl.</p>'
(p/'Results_release_v042/index.html').write_text(page,encoding='utf8')
skip={'obj','bin','__pycache__','Results_v042','Results_final_v042','validation_v042'}
files=[f for f in p.rglob('*') if f.is_file() and not any(n in skip for n in f.relative_to(p).parts) and (len(f.relative_to(p).parts)>1 or f.suffix!='.log') and f.name!='MANIFEST_SHA256.json']
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_Engine_v0.42_source.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f in sorted(files):z.write(f,'NSS_Engine_v0.42/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for n,d in manifest.items():assert hashlib.sha256(z.read('NSS_Engine_v0.42/'+n)).hexdigest()==d
 z.extractall(root/'output/verification_v042')
(root/'output/SHA256_v042.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
print('Archive CRC/SHA verified:',archive,archive.stat().st_size)
