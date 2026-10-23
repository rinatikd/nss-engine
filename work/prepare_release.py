from pathlib import Path
import hashlib
import json
import shutil
import zipfile
import difflib

root = Path(__file__).resolve().parents[1]
project = root/'work/NSS_RealDXF_v0.20'
baseline = root/'NSS_RealDXF_v0.19'
launcher = project/'Run-Analysis.ps1'
launcher.write_text(launcher.read_text(encoding='utf-8-sig'), encoding='utf-8-sig')
verification = project/'Verification'
verification.mkdir(exist_ok=True)
for name in ('verification.log', 'offline_install.log', 'offline_tests.log'):
    source = root/'output'/name
    if source.exists(): shutil.copy2(source, verification/name)
def sha(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1048576), b''): h.update(b)
    return h.hexdigest()

lock = project/'requirements-lock.txt'
raw = lock.read_bytes()
if raw.startswith(b'\xff\xfe'): lock.write_text(raw.decode('utf-16'), encoding='utf-8')
wheelhouse = project/'wheelhouse'
wheelhouse.mkdir(exist_ok=True)
for line in lock.read_text(encoding='utf8').splitlines():
    if not line.strip(): continue
    name, version = line.split('==')
    matches = [p for p in (root/'work/wheels').glob(f'{name.replace("-", "_")}-{version}-*.whl') if 'cp315' not in p.name]
    if len(matches) != 1: raise RuntimeError((line, matches))
    shutil.copy2(matches[0], wheelhouse/matches[0].name)

originals = []
changes = []
diff = []
for p in sorted(baseline.rglob('*')):
    if not p.is_file(): continue
    rel = p.relative_to(baseline)
    originals.append({'path': 'NSS_RealDXF_v0.19/'+rel.as_posix(), 'sha256': sha(p), 'bytes': p.stat().st_size})
    new = project/rel
    if new.exists() and sha(new) != sha(p):
        changes.append(rel.as_posix())
        diff.extend(difflib.unified_diff(p.read_text(encoding='utf8').splitlines(True), new.read_text(encoding='utf8').splitlines(True), fromfile='original/'+rel.as_posix(), tofile='v020/'+rel.as_posix()))
for p in sorted(root.glob('*.dxf')):
    originals.append({'path':p.name,'sha256':sha(p),'bytes':p.stat().st_size})
(project/'originals_manifest.json').write_text(json.dumps(originals,ensure_ascii=False,indent=2),encoding='utf8')
(project/'changes_from_v019.patch').write_text(''.join(diff),encoding='utf8')
overview = json.loads((project/'Results_v020/overview_v020.json').read_text(encoding='utf8'))
rows = ['| Файл | Прочитано объектов выбранных типов | Слоёв | Слоёв-кандидатов | Измерено на кандидатах | Длина кандидатов, ед. | Нулевых на всех слоях | Некорректных |', '|---|---:|---:|---:|---:|---:|---:|---:|']
for r in overview:
    rows.append(f"| {r['file']} | {r['entities_scanned']} | {r['layer_count']} | {r['candidate_layers']} | {r['candidate_measured_entities']} | {r['candidate_length_units']:.6f} | {r['zero_length_entities']} | {r['invalid_entities']} |")
invalid = []
for r in overview:
    report = json.loads((project/'Results_v020'/r['report']).read_text(encoding='utf8'))
    assert report['source_unchanged']
    assert sha(root/r['file']) == r['sha256']
    for row in report['layers']:
        g = row['geometry']
        assert row['entity_count'] == g['measured_entities']+g['invalid_entities']+sum(g['unsupported_types'].values())
        for sample in g['issue_samples']:
            if sample['reason'] != 'zero_length': invalid.append(f"- {r['file']}, слой `{row['layer']}`, handle `{sample['handle']}`: `{sample['reason']}`.")
text = '''# Отчёт NSS Engine v0.20

Дата: 16.10.2026. Рабочая копия: `work/NSS_RealDXF_v0.20`.

## Исходные материалы и происхождение

В текущей папке обнаружены четыре DXF и каталог NSS_RealDXF_v0.19. Запрошенного архива NSS_RealDXF_v0.18_AnalysisAndAutoCAD.zip нет, поэтому распаковка именно этого архива не выполнялась и происхождение проекта из него не подтверждено. Использована отдельная копия найденного каталога. Оригинальный каталог и DXF не редактировались. SHA-256 каждого DXF до и после анализа совпал; повторное хеширование при упаковке также совпало. Контрольные суммы исходного каталога и DXF — originals_manifest.json. Самих DXF в ZIP нет.

Изучены Python-модули v0.17/v0.18, реестр норм, существующие тесты, отчёт v0.18 и классификатор v0.19 с его результатами. Старые Results и Results_v019 сохранены как исторические данные, а не выданы за повторный запуск.

## Выбранный этап и изменения

Добавлен потоковый анализ готовности геометрии nss_geometry_v020.py. Классификация кандидатов берётся из существующей v0.19; измерения выполняются по всем просмотренным слоям. Для LINE длина пространственная, для ARC и LWPOLYLINE — в плоскости объекта. Bulge учитывается аналитически, в том числе на последнем замыкающем сегменте. Нет подмены дуги хордой и нет предположения, что координаты заданы в метрах. Некорректный bulge при совпадающих вершинах отклоняется, чтобы не занижать длину молча; он исключён из суммы. JSON хранит счётчики измеренных, отклонённых и неподдерживаемых объектов, причины и до десяти примеров handle на слой. Вывод не содержит NaN/Infinity.

Добавлены шесть содержательных unittest-проверок: 3D-линия, оба знака bulge, замкнутая полилиния, переход дуги через ноль и равные углы, некорректная/неподдержанная геометрия, чтение с диска с контролем ModelSpace, сохранности и баланса счётчиков. run_checks.py также исполняет четыре прежних unittest v0.19 и пять функций прежних тестов v0.18/реестра без pytest.

В ходе доступной проверки C# исправлены ссылки на AutoCAD API в csproj с параметром AutoCADDir, отсутствующий using NssEngine.Analysis, неоднозначные Exception и вызов GetDistAtParameter заменён на существующий GetDistanceAtParameter. Полный diff прежних файлов — changes_from_v019.patch; новые файлы находятся в комплекте. Алгоритм Python не переносился в AutoCAD.

## Фактические результаты

'''+ '\n'.join(rows)+'''

Прочитано 397392 объекта выбранных типов, не всех объектов DXF. Найдено 260 объектов строго нулевой длины и 3 отклонённых объекта. Нулевые объекты включают слои, не признанные кандидатами: эти числа нельзя считать количеством ошибок НСС. «Нет кандидатов» в ГП не означает отсутствия сетей.

Отклонённые объекты:

'''+ '\n'.join(invalid)+'''

Файлы не исправлялись автоматически: назначение этих объектов требует проверки. Длины кандидатов являются суммой измеренных объектов, не физической длиной сети. Для каждого слоя отдельно показаны типы, не вошедшие в измерение.

Тесты: 15/15 успешно (checks.log). Проверка синтаксиса compileall — код возврата 0. Все четыре анализа завершились, созданы четыре подробных JSON и overview_v020.json. На упаковке отдельно проверен баланс счётчиков каждого слоя и хеши DXF.

Первая пробная сборка без ссылок API: 177 ошибок, build.log. После добавления API обнаружены ошибки исходников; сохранён промежуточный build_with_api.log. Итоговая фактическая сборка: 0 ошибок, 8 предупреждений, build_final.log. Собрана build_check/NssEngine.dll. Семь предупреждений nullable из исходных CollisionAnalyzer/NetworkGraphBuilder и одно NU1900: сетевой аудит уязвимостей NuGet недоступен. DLL скомпилирована против установленного API AutoCAD 2026; работа в AutoCAD не проверялась.

## Выполненные команды

Команды выполнены в PowerShell, относительные пути указаны от корня рабочей копии, если не оговорено иное:

```powershell
# В корне исходной папки
Get-ChildItem -Force
rg --files --hidden
Copy-Item -LiteralPath NSS_RealDXF_v0.19 -Destination work/NSS_RealDXF_v0.20 -Recurse
# Python 3.12.14 из codex-primary-runtime
python.exe -m venv work/py312
work/py312/Scripts/python.exe -m pip install ezdxf==1.4.3 shapely==2.1.2 scipy==1.17.0 networkx==3.6.1 pytest==8.4.2
# Предыдущая установка не удалась: сеть заблокирована. Wheel извлечены из локального pip-кэша.
work/py312/Scripts/python.exe -m pip install --no-index --find-links work/wheels ezdxf==1.4.3 shapely==2.1.2 scipy==1.17.0 networkx==3.6.1
# Далее из work/NSS_RealDXF_v0.20
../py312/Scripts/python.exe run_checks.py
../py312/Scripts/python.exe nss_geometry_v020.py --out Results_v020 ../../NVK-SS-stroystandart.info.dxf '../../ГП_Виллы_06.10.26.dxf' '../../Садик НСС.dxf' '../../Сети НСС 30.09.26 temp.dxf'
../py312/Scripts/python.exe -m compileall -q nss_geometry_v020.py run_checks.py tests
dotnet build AutoCAD_Project_v0.18/NssEngine.csproj -c Release -o build_check
# Повторялось после исправлений
dotnet build AutoCAD_Project_v0.18/NssEngine.csproj -c Release -o build_check --no-restore
../py312/Scripts/python.exe -m pip freeze
dotnet --info
```

При первой попытке запуска проверок ошибочно использован ../../py312 вместо ../py312; исправлено, все проверки выше фактически запущены. В логах Python есть предупреждение таблицы имён шрифта и невозможности записать кэш ezdxf вне workspace; они не остановили тесты и анализ. Консольный лог может содержать повреждённое отображение кириллицы из-за кодировки PowerShell; JSON и данный отчёт сохранены в UTF-8.

Упаковка: work/prepare_release.py создаёт ZIP через zipfile, SHA-256 и перечень содержимого. Результаты отдельной проверки распакованного комплекта находятся рядом с ZIP в output.

## Что осталось непроверенным

Запрошенный исходный ZIP отсутствует. Не проверены загрузка DLL, интерфейс и команды в работающем AutoCAD. Не запускались нормативные проверки, раскрытие XREF/вложенных блоков, распознавание сети на уровне объектов и новая топология для четырёх файлов. Прежние v0.17/v0.18 DXF-анализы повторно не запускались: новый проход проверяет геометрию выбранных типов, а не воспроизводит старую очередь замечаний. POLYLINE и типы вне выбранных восьми не измеряются; INSERT и атрибуты не раскрываются. Единицы, масштаб, отметки и инженерная связность не подтверждены. pytest как отдельный runner недоступен; прежние функции выполнены через адаптер. Run-Analysis.ps1 дан для повторения пользователем; выполненные в этой сессии команды перечислены выше. Исторический Build-NssEngine.ps1 не запускался.
'''
assert sum(r['entities_scanned'] for r in overview)==397392
text += '\n## Проверка автономного комплекта\n\nZIP распакован в work/release_verify. Проверены все SHA-256 из манифеста, повторно пройдены 15 тестов. Создано чистое окружение work/offline_verify; установка всех восьми пакетов только из wheelhouse завершилась успешно, затем в этом окружении повторно пройдены 15 тестов. Логи включены в Verification. Эти проверки выполнялись до финальной перепаковки с добавлением самих логов; финальный ZIP снова проверен по CRC и манифесту. Полный анализ четырёх DXF в чистом окружении повторно не запускался.\n'
(project/'REPORT_RU.md').write_text(text,encoding='utf8')

files = [p for p in project.rglob('*') if p.is_file() and not any(x in ('__pycache__', 'obj', 'bin') for x in p.relative_to(project).parts)]
manifest = {p.relative_to(project).as_posix():sha(p) for p in files if p.name != 'MANIFEST_SHA256.json'}
(project/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
files = [p for p in project.rglob('*') if p.is_file() and not any(x in ('__pycache__', 'obj', 'bin') for x in p.relative_to(project).parts)]
archive=root/'output/NSS_RealDXF_v0.20_WorkingKit.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in sorted(files): z.write(p, 'NSS_RealDXF_v0.20/'+p.relative_to(project).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name, digest in manifest.items():
        assert hashlib.sha256(z.read('NSS_RealDXF_v0.20/'+name)).hexdigest()==digest
    listing=z.namelist()
(root/'output/ZIP_CONTENTS.txt').write_text('\n'.join(listing),encoding='utf8')
(root/'output/SHA256.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
shutil.copy2(project/'REPORT_RU.md',root/'output/REPORT_RU.md')
print(archive, archive.stat().st_size, len(listing), 'CRC and manifest OK')
