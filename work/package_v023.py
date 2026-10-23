from pathlib import Path
from collections import Counter
import difflib
import hashlib
import json
import shutil
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote

root=Path(__file__).resolve().parents[1]; p=root/'work/NSS_RealDXF_v0.23'; old=root/'work/NSS_RealDXF_v0.22'
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for b in iter(lambda:stream.read(1048576),b''):h.update(b)
    return h.hexdigest()

latest=sorted((p/'Reports').glob('*/summary.json'))[-1]
rows=json.loads(latest.read_text(encoding='utf8'))
assert len(rows)==4 and all(r['status']=='COMPLETED' for r in rows)
assert all('geometry_sources' in r['well_associations']['block_expansion'] for r in rows),'Final release pass not complete'
shutil.copytree(latest.parent,p/'Results_v023',dirs_exist_ok=True)
previous={r['file']:r for r in json.loads((old/'Results_v022/summary.json').read_text(encoding='utf8'))}
comparison=[]
for r in rows:
    assert sha(Path(r['source']))==r['sha256']==previous[r['file']]['sha256']
    assert r['entities_scanned']==previous[r['file']]['entities_scanned']
    a=r['well_associations']; b=previous[r['file']]['well_associations']
    assert not any('limit' in x['reason'] for x in a['skipped_route_entities'])
    assert a['confirmed_connections']==0
    before={w['handle']:w for w in b['wells']}
    changes=[]
    for w in a['wells']:
        earlier=before[w['handle']]
        distance=lambda item:min((n['distance_units'] for n in item['nearest_routes']),default=None)
        changes.append({'well_handle':w['handle'],'old_distance_units':distance(earlier),
            'new_distance_units':distance(w),'old_status':earlier['association_status'],
            'new_status':w['association_status'],'nearest_routes':w['nearest_routes']})
        for n in w['nearest_routes']:
            assert n['source_path']
            if n['top_insert_handle'] is not None:
                assert n['handle'] in a['block_expansion']['geometry_sources']
    comparison.append({'file':r['file'],'sha256':r['sha256'],'old_route_primitives':b['route_primitives'],
        'new_route_primitives':a['route_primitives'],'primitives_from_blocks':a['block_expansion']['primitives_from_blocks'],
        'top_level_route_inserts':a['block_expansion']['top_level_route_inserts'],
        'old_skip_records':len(b['skipped_route_entities']),'new_skip_records':len(a['skipped_route_entities']),
        'new_skip_reasons':dict(Counter(s['reason'] for s in a['skipped_route_entities'])),
        'well_changes':changes})
(p/'Results_v023/comparison_v022_v023.json').write_text(json.dumps(comparison,ensure_ascii=False,indent=2),encoding='utf8')
class Links(HTMLParser):
    def handle_starttag(self,tag,attrs):
        if tag=='a':assert (p/'Results_v023'/unquote(dict(attrs)['href'])).is_file()
Links().feed((p/'Results_v023/index.html').read_text(encoding='utf8'))

diff=[]
for name in ('nss_engine.py','nss_blocks_v023.py','nss_association_v023.py','nss_geometry_v023.py','tests/test_blocks_v023.py','START_HERE_RU.md'):
    f=p/name; before=old/name
    diff.extend(difflib.unified_diff(before.read_text(encoding='utf-8-sig').splitlines(True) if before.exists() else [],f.read_text(encoding='utf-8-sig').splitlines(True),fromfile='v022/'+name,tofile='v023/'+name))
(p/'changes_v023.patch').write_text(''.join(diff),encoding='utf8')
table=[]
for item in comparison:
    table.append(f"| {item['file']} | {item['old_route_primitives']} | {item['new_route_primitives']} | {item['primitives_from_blocks']} | {len(item['top_level_route_inserts'])} | {item['new_skip_records']} |")
welltable=[]
for item in comparison:
    for w in item['well_changes']:
        if w['well_handle'] in ('264A3B','264A40'):
            welltable.append(f"| `{w['well_handle']}` | {w['old_distance_units']:.12g} | {w['new_distance_units']:.12g} | "+', '.join('`'+n['handle']+'`' for n in w['nearest_routes'])+' |')
report='''# NSS Engine v0.23 — вложенные блоки трасс

Дата: 16.10.2026. Разработка выполнена в отдельной копии work/NSS_RealDXF_v0.23. Четыре исходных DXF и прежние версии сохранены. Исходный zip v0.18 в текущей папке отсутствует, новая версия основана на ранее найденном проекте и v0.22.

## Реализовано

Новый nss_blocks_v023.py индексирует определения BLOCK по существующему индексу iterdxf, лениво читает их из отдельного файлового дескриптора и хранит не более 64 разобранных определений в LRU-кэше. Отдельный дескриптор исключает повреждение позиции потокового чтения ModelSpace при обращении к BLOCKS. CRLF нормализуется перед ExtendedTags, как в исходном reader ezdxf.

Раскрываются локальные INSERT/MINSERT, включая вложенность, базовую точку BLOCK, перенос, вращение, масштаб по осям, отражение и OCS вставки. Матрицы вложенных преобразований перемножаются в проверенном порядке. Слой 0 наследует слой вставки; явный слой дочернего объекта имеет приоритет. Учитываются явно выбранные слои внутри блока, вставленного на другой слой. Кэш релевантности учитывает наследуемый слой, поэтому один и тот же блок на разных слоях не смешивается.

Перед раскрытием отсекаются блоки, в которых нет выбранной геометрии. Неизвестные, циклические ссылки и XREF консервативно остаются для явного отчёта. Защита: глубина 32, бюджет 250000 посещённых объектов раскрытия, проверка номинального размера массива до перечисления ячеек. Бюджет не тратится на раскрытие заведомо нерелевантных блоков. При срабатывании защиты анализ не выдаёт полный охват.

Новый nss_association_v023.py подключает раскрытие к аналитическому поиску v0.22. LINE и прямые части LWPOLYLINE поддерживают неравномерный масштаб. Круговые сегменты при неравномерном результирующем преобразовании исключаются с NonUniformScalingError, а не подменяются дугами. Поддержанные прямые части смешанной полилинии сохраняются. Учитывается результирующая матрица: взаимно компенсированные неравномерные масштабы могут сохранить круговую геометрию.

Для каждого измеренного источника внутри блока сохраняются путь вставок, имена блоков, индекс уникальной ячейки MINSERT, исходный handle объекта и эффективный слой. Эти данные находятся в block_expansion.geometry_sources. У ближайших трасс дополнительно есть source_path, source_handle и top_insert_handle. Повторные вставки одного определения не смешиваются. По каждому верхнеуровневому INSERT на слое трассы сохранены число примитивов, число пропусков и результат раскрытия.

HTML и JSON различают инвентаризацию верхнего уровня и дополнительно раскрытую геометрию привязки. Суммы длин слоёв по-прежнему относятся к верхнему уровню и не подменяются суммами символов из блоков. Подтверждения физической связности и нормативных решений не добавлены.

## Фактическое сравнение с v0.22

| DXF | Примитивов v0.22 | Примитивов v0.23 | Добавлено из блоков | Верхнеуровневых INSERT трасс | Пропусков v0.23 |
|---|---:|---:|---:|---:|---:|
'''+ '\n'.join(table)+'''

Раскрыты все 67 ранее пропущенных INSERT на выбранных слоях: 5 в «Садике» и 62 в «Сети НСС». Во всех 67 найдена поддержанная геометрия, но все имеют статус PARTIAL из-за окружностей внутри блоков. В «Садике» добавлено 40 примитивов; в «Сети НСС» — 700. Число раскрытых вложенных экземпляров больше числа корневых вставок: для «Сети НСС» оно равно 85. На финальном проходе ни один лимит не сработал.

Новые пропуски: 5 окружностей внутри блоков плюс 1 верхнеуровневая окружность в «Садике», 84 окружности внутри блоков в «Сети НСС». Это 90 записей CIRCLE, тогда как 68 записей v0.22 означали 67 нераскрытых родительских INSERT и одну окружность. Счётчики не сравниваются как «число ошибок»: единица пропуска изменилась с родительской вставки на конкретную неподдержанную геометрию внутри неё.

В NVK и ГП примитивов на двух выбранных слоях не найдено, в том числе внутри локальных блоков. Это не означает отсутствия сетей: эвристический слой-кандидат не становится выбранной трассой автоматически. Соответствие слоёв не расширялось на этом этапе.

### Изменившаяся привязка двух колодцев

| Handle колодца | Было, ед. DXF | Стало, ед. DXF | Ближайшие источники |
|---|---:|---:|---|
'''+ '\n'.join(welltable)+'''

Для 264A3B сохранены два практически равноудалённых источника. Вставка 261616 с блоком A$Cda204a7a содержит линии 2615E6 и 2615E7. Малое ненулевое расстояние порядка 10⁻¹² — результат вычислений double, не независимое подтверждение нулевого физического зазора. Для 264A40 расстояние до измеренной линии составляет около 0,205052 координатной единицы.

Все 11 найденных символов/колодцев сохраняют REVIEW_INCOMPLETE_ROUTE_GEOMETRY из-за неподдержанных окружностей. Найденная близость относится к измеренной геометрии выбранных слоёв, а назначение линий внутри блока требует проверки. Подтверждённых соединений — 0. Результаты по всем колодцам и точные пути — Results_v023/comparison_v022_v023.json и подробные JSON.

## Тесты и выполненные проверки

53 теста прошли через переносимый Run-NSS.cmd --check: 34 прежних и 19 новых. Новые сценарии проверяют базовую точку, перенос/поворот/масштаб; порядок вложенных матриц и слой 0; явные дочерние слои под нерелевантной вставкой; исключение чужого слоя; сохранение источников повторных вставок; отражённую дугу; отказ от неравномерно масштабированной дуги; прямую замкнутую полилинию; смешанную полилинию с частичным результатом; компенсацию масштабов; нечисловую вставку; MINSERT; поворот шага массива без масштабирования шага; огромный массив; циклы и отсутствующее определение; XREF; глубину и бюджет; отсечение большого нерелевантного блока; разделение кэша по наследуемому слою. Каждый синтетический DXF читается с диска, проверяется сохранность исходника и строгая JSON-сериализация.

Первый прогон тестов обнаружил необходимость нормализации CRLF при чтении BLOCK; ошибка исправлена. Первый реальный проход выявил расходование бюджета на нерелевантные блоки: в NVK и «Сети НСС» достигался лимит. Добавлено отсечение по релевантности и отдельный регрессионный тест. Последующие реальные проходы завершились без достижения лимитов. Поэтому первоначальный результат с ограниченным охватом не выдаётся за финальный.

Выполнены четыре полных прохода четырёх DXF на разных стадиях: первоначальный, после отсечения нерелевантных блоков, после итоговых проверок и финальный с сохранением всех источников. Актуальный Results_v023 скопирован из последнего переносимого запуска. SHA-256 каждого исходного DXF совпал с v0.22 и при упаковке. Счётчик выбранных верхнеуровневых объектов остался 397392; общий список замечаний их геометрии — 263. Ссылки HTML на локальные файлы проверены программно. Визуальная проверка браузером не выполнялась.

Основные команды (из рабочей папки v0.23):

```text
Run-NSS.cmd --check
runtime/python.exe -m compileall -q nss_engine.py nss_blocks_v023.py nss_association_v023.py nss_geometry_v023.py
Run-NSS.cmd ../..
```

Из корня workspace: work/py312/Scripts/python.exe work/package_v023.py. ZIP проверяется по CRC и SHA-256 всех файлов. Затем он отдельно распаковывается и тестируется поставляемым runtime; результат — output/verification_v023.log. Логи проходов: analysis_v023.log, analysis_pruned_v023.log, analysis_final_v023.log, analysis_release_v023.log; итоговые тесты — checks_v023.log. Предупреждения шрифта и недоступного кэша ezdxf сохраняются в логах, но не остановили проверки. Код и изменения — changes_v023.patch и исходники комплекта.

## Ограничения и непроверенное

Поддержка блоков реализована только в самостоятельном Python-анализаторе. DLL и C# версии 0.21 сохранены без изменений; новой сборки и проверки внутри AutoCAD в этом этапе не было. Сохраняется ранее установленный блокер профиля AutoCAD/недоступного канала UI, поэтому работу в AutoCAD не заявляем.

Не раскрываются XREF и вложенные колодцы, не учитываются смещения точки подключения символа. CIRCLE/POLYLINE/SPLINE, наклонные дуги и эллиптические сегменты после неравномерного масштаба не используются как трассы. Скрытые/выключенные слои, динамическая видимость блоков и XCLIP не интерпретируются: анализируется сохранённая геометрия, которая может отличаться от видимого состояния. Настройка осей остаётся прежней: пр_телефонная_канализация и НСС проектир. Геометрия блока на таком слое может быть условным знаком, поэтому близость — кандидат для проверки, не доказательство подключения. Единицы не объявляются метрами, порог 1,0 — параметр поиска, не норматив. Масштаб, высоты, инженерная связность и соответствие нормам не подтверждены.

Запуск: START_HERE_RU.md и Run-NSS.cmd; внешний Python и сеть не нужны. Исторические отчёты сохранены, актуальный манифест — MANIFEST_v023_SHA256.json.
'''
(p/'REPORT_v023_RU.md').write_text(report,encoding='utf8')
assert sha(p/'build_check/NssEngine.dll')==sha(old/'build_check/NssEngine.dll')
skip={'__pycache__','obj','bin','wheelhouse','Reports'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and not f.name.startswith('MANIFEST')]
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_v023_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_v023_SHA256.json')
archive=root/'output/NSS_Engine_v0.23_Portable.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files):z.write(f,'NSS_Engine_v0.23/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,digest in manifest.items():assert hashlib.sha256(z.read('NSS_Engine_v0.23/'+name)).hexdigest()==digest
(root/'output/SHA256_v023.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
shutil.copy2(p/'REPORT_v023_RU.md',root/'output/REPORT_v023_RU.md')
print('ZIP OK:',archive.stat().st_size,'bytes;',len(files),'files')
