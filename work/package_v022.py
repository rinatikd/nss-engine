from pathlib import Path
from collections import Counter
import hashlib
import json
import shutil
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote

root=Path(__file__).resolve().parents[1]; p=root/'work/NSS_RealDXF_v0.22'
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for b in iter(lambda:stream.read(1048576),b''):h.update(b)
    return h.hexdigest()

latest=sorted((p/'Reports').glob('*/summary.json'))[-1]
rows=json.loads(latest.read_text(encoding='utf8'))
initial=json.loads((p/'Results_v022/summary.json').read_text(encoding='utf8'))
assert len(rows)==4 and all(r['status']=='COMPLETED' for r in rows)
for r,previous in zip(rows,initial):
    assert r['sha256']==previous['sha256']==sha(Path(r['source']))
    assert r['entities_scanned']==previous['entities_scanned']
    assert r['well_associations']['route_primitives']==previous['well_associations']['route_primitives']
    assert r['well_associations']['confirmed_connections']==0
    for w,prev in zip(r['well_associations']['wells'],previous['well_associations']['wells']):
        assert w['nearest_routes']==prev['nearest_routes']
        assert w['association_status']==prev['association_status']
shutil.copytree(latest.parent,p/'Results_v022',dirs_exist_ok=True)

class Links(HTMLParser):
    def handle_starttag(self,tag,attrs):
        if tag=='a':assert (p/'Results_v022'/unquote(dict(attrs)['href'])).is_file()
Links().feed((p/'Results_v022/index.html').read_text(encoding='utf8'))
table=[]
for r in rows:
    a=r['well_associations']
    table.append(f"| {r['file']} | {r['entities_scanned']} | {a['route_primitives']} | {len(a['wells'])} | {len(a['skipped_route_entities'])} |")
wellrows=[]
for r in rows:
    for w in r['well_associations']['wells']:
        if w['evidence_type']=='dedicated_well_layer':
            for near in w['nearest_routes']:
                wellrows.append(f"- `{w['handle']}` → `{near['handle']}`: {near['distance_units']:.12f} ед.; `{w['association_status']}`.")
report='''# NSS Engine v0.22 — аналитическая привязка колодцев к выбранным трассам

Дата: 16.10.2026. Рабочая папка work/NSS_RealDXF_v0.22, отдельная копия v0.21. Исходные DXF и предыдущие версии не изменены. Архив v0.18 по-прежнему отсутствует; происхождение проекта не переопределялось.

## Изменения

Новый nss_association_v022.py строит точные плановые примитивы LINE/ARC из выбранных слоёв, включая дуговые сегменты bulge и замыкающее ребро LWPOLYLINE. Старый segment_index v0.18 игнорировал закрывающее ребро, а координаты bulge заменял хордами; это могло выбирать неверную ближайшую трассу. Старые модули сохранены без подмены исторических результатов; запускатель теперь использует nss_geometry_v022.py и новый анализ привязки.

Расстояние до прямой вычисляется проекцией на отрезок, до дуги — радиальной проекцией при попадании в угловой сектор, иначе до ближайшего конца. Учтены переход через 0°, отрицательный bulge, зеркальная OCS −Z, перенос координат. Наклонные OCS явно отклоняются. Индекс STRtree хранит ограничивающие прямоугольники; для точного результата вычисляются все кандидаты, способные улучшить первоначальную верхнюю границу расстояния. Все равноудалённые handles сохраняются с детерминированным порядком (числовой допуск для равенства 1e−10 × max(1, distance)). Решение о пороге использует неокруглённое расстояние.

За один потоковый проход reader-supported ModelSpace выполняются инвентаризация выбранных восьми типов и сбор привязок. Для контроля охвата на выбранных слоях также учитываются поддерживаемые reader типы вне восьми, например SPLINE. POLYLINE/SPLINE/INSERT/CIRCLE и другие неподдержанные объекты трассы получают явную причину и handle. При их наличии итоговый статус колодцев REVIEW_INCOMPLETE_ROUTE_GEOMETRY, а расстояние относится только к измеренным примитивам. Некорректная точка вставки получает INVALID_WELL_POSITION и сериализуется без NaN. Отсутствие выбранных примитивов обозначается NO_SELECTED_ROUTE.

Новый раздел HTML показывает точки колодцев по handle, расстояния, неоднозначность ближайших трасс через список всех handles, выбранные слои и перечень пропусков. Полная структурированная информация — well_associations в JSON. Общий список 263 замечаний геометрии сохраняется отдельно; 68 пропусков геометрии трасс не смешиваются с ним.

## Проверки

Все 34 Python-теста прошли через Run-NSS.cmd --check. Из них 14 новых проверок: оба знака bulge; замыкающее ребро; сектор дуги через 0°; OCS −Z; равноудалённые трассы при разном порядке входа; неокруглённый порог; неполный охват; отсутствие выбранных трасс; некорректная точка вставки и строгий JSON; перенос и замыкающий bulge; индекс против полного перебора; аналитическая дуга против независимой плотной выборки; чтение SPLINE из DXF с сохранностью исходника; полный оборот ARC в отличие от равных углов. Для независимой проверки дуг использованы 4097 точек на дугу и оценка ошибки через длину шага.

compileall для новых модулей и запускателя — успешно. Фактически выполнены три полных анализа четырёх DXF: прямой CLI и два запуска переносимого Run-NSS.cmd. Расстояния, выбранные handles, статусы и счётчики запусков совпали. SHA-256 каждого DXF совпал между проходами и при упаковке. Все локальные ссылки HTML проверены программно. Визуальная проверка HTML в браузере не выполнялась: доступный ранее браузер недоступен.

| Файл | Объектов выбранных типов | Примитивов выбранных трасс | Колодцев/символов | Пропущено объектов трасс |
|---|---:|---:|---:|---:|
'''+ '\n'.join(table)+'''

В NVK и ГП выбранные два слоя трасс и блоки колодцев по заданным правилам не найдены. Это не доказательство отсутствия НСС. Примитивы дуг теперь считаются как дуги, а не как число аппроксимирующих хорд; этот счётчик нельзя напрямую сравнивать с selected_route_segments v0.18.

В Садике пропущены 5 INSERT и 1 CIRCLE, в «Сети НСС» — 62 INSERT на слоях трасс. Так как содержимое блоков не раскрыто, все 11 обнаруженных символов колодцев получают статус неполного охвата. Это сознательно более точное описание ограничений, чем уверенное утверждение об изоляции относительно неполной трассы.

Колодцы специализированного слоя:

'''+ '\n'.join(wellrows)+'''

Для этих двух колодцев ближайший измеренный handle совпал с v0.18. Расстояния близки к прежним 7.0 и 7.20505, но статус теперь отражает пропуски геометрии. Подтверждённых соединений — 0. Нормативные расстояния не применялись, масштаб и высоты не подтверждались.

## Выполненные команды

```text
копирование work/NSS_RealDXF_v0.21 в work/NSS_RealDXF_v0.22 без старых obj/bin/Reports/wheelhouse
Run-NSS.cmd --check
runtime/python.exe -m compileall -q nss_engine.py nss_association_v022.py nss_geometry_v022.py launch_nss.py
runtime/python.exe -E -s -X utf8 nss_engine.py --directory ../.. --out Results_v022
Run-NSS.cmd ../..
work/py312/Scripts/python.exe work/package_v022.py
```

Первая проверка синтаксиса обнаружила ошибку кавычек в формировании HTML; исправлена до успешных тестов и реальных запусков. После добавления проверок некорректной точки и полного оборота ARC выполнены повторные переносимые анализы всех четырёх файлов. Финальный Results_v022 взят из последнего запуска. Логи: checks_v022.log, analysis_v022.log, portable_analysis_v022.log, portable_final_analysis_v022.log. В логах могут присутствовать прежние предупреждения шрифта и недоступного каталога кэша ezdxf; они не остановили проверки и проходы.

## Что не проверено и не изменено

Новый аналитический алгоритм не перенесён в AutoCAD DLL. Исходники C# и build_check/NssEngine.dll версии 0.21 сохранены без изменений; новая сборка C# на этом этапе не требовалась. Ранее установленный блокер запуска AutoCAD (профиль/реестр до NETLOAD) и недоступность UI не устранены. NSS_SELFTEST в AutoCAD не выполнялась. Исторические логи сборки не являются новой проверкой.

Привязка выполняется только к слоям пр_телефонная_канализация и НСС проектир, а не ко всем эвристическим кандидатам. Настройка соответствия слоёв, раскрытие вложенных блоков и XREF, поддержка наклонных кривых, POLYLINE/SPLINE, профиль по Z и инженерная связность остаются следующими задачами. Расстояния вычисляются в XY от точки INSERT, смещение условного знака внутри блока не учтено. Порог близости 1,0 координатная единица сохранён как параметр поиска, не как норма. Точность double не является произвольной математической точностью. Не доказана работоспособность приложения внутри AutoCAD.

Комплект содержит переносимое окружение Windows x64, исходники, тесты, инструкции, актуальные и исторические результаты. Актуальный манифест — MANIFEST_v022_SHA256.json; CRC и SHA-256 всех записей проверяются при упаковке. Проверка окончательно распакованного ZIP записывается в output/verification_v022.log.
'''
(p/'REPORT_v022_RU.md').write_text(report,encoding='utf8')
assert sha(p/'build_check/NssEngine.dll')==sha(root/'work/NSS_RealDXF_v0.21/build_check/NssEngine.dll')
skip={'__pycache__','obj','bin','wheelhouse','Reports'}
old_manifests={'MANIFEST_SHA256.json','MANIFEST_v021_SHA256.json','MANIFEST_v022_SHA256.json'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and f.name not in old_manifests]
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_v022_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8'); files.append(p/'MANIFEST_v022_SHA256.json')
archive=root/'output/NSS_Engine_v0.22_Portable.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files):z.write(f,'NSS_Engine_v0.22/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,digest in manifest.items():assert hashlib.sha256(z.read('NSS_Engine_v0.22/'+name)).hexdigest()==digest
(root/'output/SHA256_v022.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
shutil.copy2(p/'REPORT_v022_RU.md',root/'output/REPORT_v022_RU.md')
print('ZIP OK:',archive.stat().st_size,'bytes;',len(files),'files')
