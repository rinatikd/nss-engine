from pathlib import Path
import json,hashlib,shutil,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_AutoBuild_v0233'
def sha(f):
    with f.open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
e=p/'Evidence';e.mkdir(exist_ok=True)
old=root/'output/NSS_AutoBuild_v0.23.2_Fix/NSS_AutoBuild_v0232/Runs/20261017_071247_13a08045'
shutil.copy2(old/'status.json',e/'previous_full_status.json')
for f in (old/'reports').glob('*'):
    if f.is_file():shutil.copy2(f,e/f.name)
latest=sorted((p/'Runs').glob('*/status.json'))[-1]
assert json.loads(latest.read_text(encoding='utf8'))['phase']=='PREPARED'
shutil.copy2(latest,e/'prepared_status.json');shutil.copy2(latest.parent/'build.log',e/'build.log')
for name in ('regression033.log','unit_tests033.log','prepare033.log'):shutil.copy2(p/name,e/name)
(p/'README_RU.md').write_text('''# NSS AutoBuild 0.23.3

Распакуйте в отдельную папку. Нужны AutoCAD 2026 и .NET SDK с поддержкой net8.0-windows. Python включён; отдельные регрессионные проверки требуют .NET 10.

Закройте предыдущий тестовый AutoCAD после сохранения нужных изменений: новая DLL должна загружаться в новый процесс. Откройте CMD в папке комплекта и выполните:

```bat
Build-And-Run.cmd --mode gui --checks full --drawing "C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\Садик НСС.dxf" --timeout 180
```

Сценарий собирает DLL, копирует DXF в уникальную Runs-папку, запускает AutoCAD, NSS_SELFTEST и NSS_EXPORT_DIAGNOSTICS. Исходный DXF не редактируется. Ожидаемый проверяемый итог — PASSED; ANALYSIS_INCOMPLETE означает частичный анализ, нулевые счётчики в нём не доказывают отсутствие проблем. Сообщите путь Runs и итог консоли. По умолчанию двойной щелчок выполняет только selftest на маленьком smoke.dxf.

```bat
Build-And-Run.cmd --mode prepare
Build-And-Run.cmd --collect "Runs\\папка_запуска"
Build-And-Run.cmd --cancel "Runs\\папка_запуска"
runtime\\python.exe -E -s -X utf8 -m unittest -v test_autobuild
dotnet run --project Regression/Regression.csproj -p:NuGetAudit=false
```

prepare только собирает и готовит сценарии, не проверяет работу AutoCAD. cancel создаёт запрос кооперативной отмены, не завершает процесс. Сохраняются бюджеты 250000 контрольных операций/этап, 5 секунд/этап, 25 секунд/анализ; они не прерывают один нативный вызов AutoCAD. Старую ошибочную автозагрузку из C:/NSS_Engine/v0.9_buildfix3 этот комплект не меняет.

Повтор офлайн-классификации: `runtime\\python.exe -E -s -X utf8 replay_recognition.py "путь1.dxf" "путь2.dxf" "путь3.dxf" "путь4.dxf"`. Исходники — AutoCAD_Project, тесты — Regression и test_autobuild.py, результаты — Replay, подтверждения — Evidence. Подробности и ограничения — REPORT_RU.md.
''',encoding='utf8')
rows=json.loads((p/'Replay/overview.json').read_text(encoding='utf8'))
table='\n'.join(f"| {x['file']} | {x['records']} | {x['recognized']} |" for x in rows)
(p/'REPORT_RU.md').write_text('''# Отчёт NSS 0.23.3 — 17.10.2026

Фактический запуск AutoCAD 0.23.2 на «Садик НСС» (13a08045) выгрузил отчёты, но результат ANALYSIS_INCOMPLETE: этап collisions остановлен на 250001 контрольной операции. Остальные этапы завершились. Следовательно, сохранение JSON само по себе не означало успешный полный анализ. Ранее пользователь подтвердил отзывчивое окно и четыре успешные самопроверки 0.23.2.

Исправлена формула объединения свидетельств: раньше одиночный вес геометрии 0.08 превращался в confidence 0.92; теперь применяется 1−произведение(1−вес). Геометрия без смыслового признака не назначает тип сети. Исключены слои условных обозначений/оформления (отдельный счётчик), уточнены границы токенов, приоритет точных слоёв и правила для газа, электросетей, связи, водопровода, канализации и тепла. Общие «Каналы» не считаются доказательством канализации.

CollisionAnalyzer один раз открывает кривые и получает габариты, затем BoxSweep отбирает пространственно близкие пары разных сетей перед прежними точными нативными проверками. Это сокращает лишний перебор; не является новой методикой нормативной оценки. Бюджеты защиты не увеличивались. Ошибка получения габаритов помечает анализ неполным.

Фактически выполнены команды:

```text
runtime/python.exe -E -s -X utf8 -m unittest -v test_autobuild
dotnet run --project Regression/Regression.csproj -p:NuGetAudit=false
runtime/python.exe -E -s -X utf8 replay_recognition.py <четыре исходных DXF>
dotnet Regression/bin/Debug/net10.0/Regression.dll --replay <кэш полей DXF> <JSON>
Build-And-Run.cmd --mode prepare
```

После уточнения правил C# replay повторён на сохранённых полях всех четырёх DXF. Пройдено 18 тестов запуска и 23 проверки C# (41 всего); сборка плагина net8.0-windows — 0 ошибок, 0 предупреждений. Сообщения BUILD_FAILED/TEST_FAILED внутри журнала unittest — ожидаемые проверки отрицательных сценариев; итог unittest OK. NuGetAudit отключён, сетевой аудит пакетов не выполнялся.

Новые содержательные проверки: формула confidence, отсутствие сети по одной геометрии, слои оформления, газ/связь/точные слои, границы сокращений, неоднозначные каналы; совпадение BoxSweep с полным перебором на случайном наборе, граничные случаи и 20000 разнесённых объектов в ограниченном бюджете. Сохранились проверки отмены, бюджетов, пространственной сетки и достоверности итогов автозапуска.

Офлайн-повтор именно C# классификатора на поддерживаемых ModelSpace-объектах:

| DXF | Прочитано | Распознано |
|---|---:|---:|
'''+table+'''

Во всех четырёх выборках geometryOnlyAccepted=0. SHA-256 исходников до/после совпали (Replay/overview.json). Офлайн-читатель не охватывает все прокси/типы AutoCAD; например, «Садик» содержит 12113 доступных записей против 12157 объектов прежнего нативного отчёта. Разбор MText также может отличаться. Число 648 нельзя объявлять подтверждённым нативным итогом.

Не проверено: загрузка DLL 0.23.3 и полный анализ в AutoCAD; нативные пересечения и отмена через UI на новой версии; полный анализ всех четырёх DXF новой DLL; инженерная правильность каждого распознанного объекта. Вложенные блоки Python v0.23 не перенесены в C#. Офлайн replay проверяет классификацию, не заменяет полный геометрический анализ. Следующий шаг — новый GUI-запуск «Садик НСС» по README. Исходники и прежние комплекты сохранены.

ZIP проверяется по CRC и MANIFEST_SHA256.json. Результаты повторной проверки извлечённого комплекта записываются отдельно в output/verification_fix0233.log.
''',encoding='utf8')
skip={'Runs','ReplayInputs','obj','bin','__pycache__','build_check'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and (len(f.relative_to(p).parts)>1 or f.suffix not in ('.log',)) and f.name not in ('MANIFEST_SHA256.json','attempts.json')]
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_AutoBuild_v0.23.3_Fix.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files):z.write(f,'NSS_AutoBuild_v0233/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for n,d in manifest.items():assert hashlib.sha256(z.read('NSS_AutoBuild_v0233/'+n)).hexdigest()==d
    z.extractall(root/'output/verification_fix0233')
shutil.copy2(p/'REPORT_RU.md',root/'output/REPORT_Fix0233_RU.md')
(root/'output/SHA256_Fix0233.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
print('ZIP CRC/SHA verified',archive.stat().st_size)
