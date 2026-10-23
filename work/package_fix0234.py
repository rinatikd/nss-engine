from pathlib import Path
import hashlib,json,shutil,subprocess,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_AutoBuild_v0234';e=p/'Evidence';e.mkdir(exist_ok=True)
def sha(f):
 with f.open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
old=root/'output/NSS_AutoBuild_v0.23.3_Fix/NSS_AutoBuild_v0233/Runs/20261017_081005_72b0f54c'
shutil.copy2(old/'status.json',e/'previous_native_status.json')
for f in (old/'reports').glob('*'):
 if f.is_file():shutil.copy2(f,e/f.name)
for n in ('regression034.log','unit_tests034.log','prepare034.log'):shutil.copy2(p/n,e/n)
latest=sorted((p/'Runs').glob('*/status.json'))[-1];assert json.loads(latest.read_text(encoding='utf8'))['phase']=='PREPARED'
shutil.copy2(latest,e/'prepared_status.json');shutil.copy2(latest.parent/'build.log',e/'build.log')
rows=json.loads((p/'Replay/overview.json').read_text(encoding='utf8'))
for i,row in enumerate(rows,1):
 assert sha(root/row['file'])==row['sha256']
 run=subprocess.run(['dotnet',str(p/'Regression/bin/Debug/net10.0/Regression.dll'),'--replay',str(root/f'work/NSS_AutoBuild_v0233/ReplayInputs/{i:02d}_input.jsonl'),str(p/'Replay'/row['report'])],capture_output=True)
 assert run.returncode==0
 result=json.loads((p/'Replay'/row['report']).read_text(encoding='utf8'));assert result['recognized']==row['recognized'] and result['geometryOnlyAccepted']==0
 (p/'Replay'/f'{i:02d}_replay.log').write_bytes(run.stdout+run.stderr)
table='\n'.join(f"| {r['file']} | {r['records']} | {r['recognized']} |" for r in rows)
(p/'README_RU.md').write_text('''# NSS AutoBuild 0.23.4

Закройте предыдущий тестовый AutoCAD, сохранив нужные изменения. Распакуйте ZIP в отдельную папку, откройте CMD **в подпапке NSS_AutoBuild_v0234**, где находится Build-And-Run.cmd. Выполните:

```bat
Build-And-Run.cmd --mode gui --checks full --drawing "C:\\Users\\r.dautbekov\\Downloads\\NSS_Engine\\Садик НСС.dxf" --timeout 180
```

Сценарий собирает DLL и запускает AutoCAD с копией DXF, самопроверками и диагностикой. Исходник не редактируется. Сообщите путь Runs и итог консоли. PASSED подтверждает техническое завершение проверок, не нормативное соответствие проекта. ANALYSIS_INCOMPLETE — частичный результат. По умолчанию запускается только selftest на smoke.dxf.

Нужны AutoCAD 2026, .NET SDK с net8.0-windows; для отдельных Regression-тестов — .NET 10. Python включён.

```bat
Build-And-Run.cmd --mode prepare
Build-And-Run.cmd --collect "Runs\\папка"
Build-And-Run.cmd --cancel "Runs\\папка"
runtime\\python.exe -E -s -X utf8 -m unittest -v test_autobuild
dotnet run --project Regression/Regression.csproj -p:NuGetAudit=false
```

prepare только собирает и готовит запуск. cancel запрашивает кооперативную отмену. Лимиты: 250000 контрольных операций/этап, 5 секунд/этап, 25 секунд/анализ. Один нативный вызов они прервать не могут. Старую автозагрузку v0.9_buildfix3 комплект не меняет.

Исходники: AutoCAD_Project; тесты: Regression и test_autobuild.py; отчёты: REPORT_RU.md, Replay, Evidence. Для повтора офлайн-классификации: runtime\\python.exe -E -s -X utf8 replay_recognition.py "путь1.dxf" "путь2.dxf" "путь3.dxf" "путь4.dxf".
''',encoding='utf8')
(p/'REPORT_RU.md').write_text('''# NSS 0.23.4 — отчёт 17.10.2026

Основание: реальный GUI-запуск 0.23.3, 72b0f54c. DLL загрузилась, четыре самопроверки успешны; распознано 656 объектов/17 групп, исключено 5462 объекта оформления. Collisions прерван на 250001 операции за 0.0438 с; итог ANALYSIS_INCOMPLETE. Другие этапы завершены. Нулевое число коллизий в таком отчёте не означает их отсутствие.

При разборе исходников обнаружен оставшийся глобальный квадратичный поиск дублей конфликтов. Заменён словарём по упорядоченной паре групп, типу конфликта и двум исходным ObjectId. Сравнение точек выполняется только внутри этой пары; сохранены строгий 3D-допуск <1e-9 и порядок вставки. Не применяется деление больших координат на микроскопический допуск, способное переполнить целочисленный индекс. Внутри одной пары список остаётся линейным и ограничен прежним бюджетом.

BoxSweep теперь выбирает X или Y по нормированной суммарной ширине габаритов. Это устраняет вырождение фиксированной X-сортировки на вертикальном наборе. Выбор оси — эвристика производительности, состав пар сохраняется. Плотные перекрытия всё ещё могут требовать квадратичного числа пар. Лимиты не повышены. В исключение превышения операций добавлена метка участка: отбор габаритов, обработка пары или удаление дублей.

Нельзя по старому журналу доказать, какой из внутренних участков исчерпал бюджет: эти исправления устраняют установленные кодом проблемы, но требуют нового нативного запуска для подтверждения результата на «Садик НСС».

Фактически выполнено:

```text
dotnet run --project Regression/Regression.csproj -p:NuGetAudit=false
runtime/python.exe -E -s -X utf8 -m unittest discover -s <папка комплекта> -p test_autobuild.py
Build-And-Run.cmd --mode prepare
dotnet Regression/bin/Debug/net10.0/Regression.dll --replay <сохранённые поля каждого DXF> <JSON>
```

28 C# проверок и 18 Python-тестов прошли (46 всего). Сборка плагина: 0 ошибок и 0 предупреждений. Новые тесты: 5000 разных пар в бюджете 20000 операций, совпадение удаления дублей с полным перебором на 10000 входах, строгая граница допуска/разделение Z и ключей, 20000 вертикально разнесённых габаритов в бюджете 50000, сохранение всех 2500 межсетевых пар плотного набора. Случайный отбор габаритов по-прежнему сравнивается с исчерпывающим эталоном. Сообщения отрицательных сценариев внутри unittest ожидаемы; итог OK. NuGetAudit отключён, сетевой аудит пакетов не проверен.

Классификатор не менялся. Его C# повтор на кэше поддерживаемых ModelSpace-записей всех четырёх исходных DXF выполнен заново:

| DXF | Записей | Распознано |
|---|---:|---:|
'''+table+'''

geometryOnlyAccepted=0 для всех; SHA-256 исходных DXF совпали с сохранёнными значениями. Это повтор классификации, не полный геометрический анализ в AutoCAD. Кэш полей не включён из-за размера; скрипт replay_recognition.py создаёт его заново. Reader не охватывает все прокси/типы AutoCAD и может иначе разбирать MText: офлайн «Садик» 12113 записей/648 распознанных, нативная 0.23.3 — 12157/656. Отчёты Replay содержат актуальные повторные результаты, build.log в Replay относится к предыдущему захвату и не является сборкой новой версии; новая сборка — Evidence/build.log.

Не проверено: загрузка 0.23.4 в AutoCAD, нативные пересечения новой версии и завершение полного анализа на четырёх DXF, отмена через UI. Прежняя методика приближённого расстояния не перерабатывалась; инженерная достоверность каждой находки не подтверждена. Вложенные блоки Python не перенесены в C#. Исходники, оригиналы и предыдущие комплекты сохранены.

Архив проверен по CRC и SHA-256 manifest. Повторная проверка извлечённого ZIP (тесты и prepare) — output/verification_fix0234.log. Следующий шаг — один новый GUI-запуск «Садик НСС» по README.
''',encoding='utf8')
skip={'Runs','ReplayInputs','obj','bin','__pycache__','build_check'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and (len(f.relative_to(p).parts)>1 or f.suffix!='.log') and f.name not in ('MANIFEST_SHA256.json','attempts.json')]
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_AutoBuild_v0.23.4_Fix.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for f in sorted(files):z.write(f,'NSS_AutoBuild_v0234/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for n,d in manifest.items():assert hashlib.sha256(z.read('NSS_AutoBuild_v0234/'+n)).hexdigest()==d
 z.extractall(root/'output/verification_fix0234')
shutil.copy2(p/'REPORT_RU.md',root/'output/REPORT_Fix0234_RU.md')
(root/'output/SHA256_Fix0234.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
print('ZIP verified',archive.stat().st_size)
