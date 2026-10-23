from pathlib import Path
import difflib
import hashlib
import json
import shutil
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote

root=Path(__file__).resolve().parents[1]
p=root/'work/NSS_RealDXF_v0.21'; old=root/'work/NSS_RealDXF_v0.20'
def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for b in iter(lambda:stream.read(1048576),b''):h.update(b)
    return h.hexdigest()

summ=json.loads((p/'Results_v021/summary.json').read_text(encoding='utf8'))
assert len(summ)==4 and all(r['status']=='COMPLETED' for r in summ)
assert sum(r['issues'] for r in summ)==263
for r in summ:
    assert sha(Path(r['source']))==r['sha256']
portable=sorted((p/'Reports').glob('*/summary.json'))[-1]
second=json.loads(portable.read_text(encoding='utf8'))
assert [(r['file'],r['sha256'],r['issues'],r['entities_scanned']) for r in summ]==[(r['file'],r['sha256'],r['issues'],r['entities_scanned']) for r in second]

class Links(HTMLParser):
    def handle_starttag(self,tag,attrs):
        if tag=='a':
            target=dict(attrs).get('href','')
            assert (p/'Results_v021'/unquote(target)).is_file(),target
Links().feed((p/'Results_v021/index.html').read_text(encoding='utf8'))

evidence=p/'RuntimeEvidence'; evidence.mkdir(exist_ok=True)
for name in ('core_initial.log','core_help.log','core_isolated.log','smoke.scr','smoke.dxf','prepare_smoke.py'):
    shutil.copy2(root/'work/runtime_v021'/name,evidence/name)
(evidence/'ui_error.txt').write_text('sky.list_apps: Computer Use native pipe is unavailable: failed to connect native pipe (os error 2).\ncua.createBrowserTab: Browser is not available: iab\n',encoding='utf8')
diff=[]
for f in sorted((p/'AutoCAD_Project_v0.18').rglob('*')):
    if f.suffix not in ('.cs','.csproj','.ps1'):continue
    if any(x in ('obj','bin') for x in f.relative_to(p).parts):continue
    prev=old/f.relative_to(p)
    before=prev.read_text(encoding='utf-8-sig').splitlines(True) if prev.exists() else []
    after=f.read_text(encoding='utf-8-sig').splitlines(True)
    if before!=after:diff.extend(difflib.unified_diff(before,after,fromfile='v020/'+f.relative_to(p).as_posix(),tofile='v021/'+f.relative_to(p).as_posix()))
(p/'changes_v021.patch').write_text(''.join(diff),encoding='utf8')
table='\n'.join(f"| {r['file']} | {r['entities_scanned']} | {r['candidate_layers']} | {r['issues']} |" for r in summ)
report='''# NSS Engine 0.21 — фактический статус продукта

16.10.2026. Рабочая папка: work/NSS_RealDXF_v0.21. v0.20, первоначальная папка v0.19 и четыре исходных DXF сохранены.

## Что теперь работает и проверено

Переносимый анализатор DXF запускается через Run-NSS.cmd. В runtime включён Python 3.12.14 x64 со стандартной библиотекой, зависимостями и лицензиями. Системный Python, pip и сеть не требуются. Фактически выполнен запуск Run-NSS.cmd с исходной папкой: все четыре DXF обработаны повторно. Хеши и результаты обоих запусков совпали. Python окружения пользователя игнорируются запускателем (-E -s); команды самопроверки также используют поставляемый интерпретатор.

Добавлены nss_engine.py, launch_nss.py, nss_geometry_v021.py. Получаются русскоязычный HTML, JSON по файлам, сводка и полный CSV с handle. В v0.20 сохранялось не более десяти примеров на слой; теперь все 263 найденных объекта доступны для просмотра. Ошибка одного входного файла не останавливает остальные; при этом итоговый код ненулевой. Файлы с одинаковыми базовыми именами получают разные имена отчётов. Исходники и непустая папка отчёта защищены от перезаписи. Сообщения и имена экранируются в HTML, ссылки кодируются. HTML не загружает внешние ресурсы.

20 автоматических Python-тестов прошли в рабочем окружении и через переносимый запускатель. Добавлены пять содержательных проверок поведения продукта: полный список 25 замечаний без потерь и сохранность DXF; продолжение после сбоя; защита исходников и прежних результатов; одинаковые имена файлов; экранирование HTML. compileall завершился успешно. Ссылки HTML на локальные отчёты проверены программно. Визуальная проверка в браузере не состоялась: браузер iab недоступен.

| DXF | Просмотрено выбранных объектов | Слоёв-кандидатов | Объектов для просмотра |
|---|---:|---:|---:|
'''+table+'''

Всего просмотрено 397392 объекта восьми выбранных типов ModelSpace. 263 объекта для просмотра — это 260 нулевых и 3 отклонённых дуговых сегмента с совпадающими вершинами. Это не количество подтверждённых инженерных ошибок. SHA-256 всех четырёх файлов совпал до/после проходов и при упаковке. Состав типов и ограничения остаются явно указаны в отчёте: LINE, ARC, LWPOLYLINE измеряются; другие выбранные типы учитываются без измерения, XREF/вложенные блоки не раскрываются. Нет нормативной проверки и подтверждения физической связности, единицы не объявляются метрами.

## Исправления плагина

- При неизвестном масштабе поиск конфликтов пропускается с явным COLLISION_SCAN_UNITS_UNKNOWN; не выдаётся ложное сообщение «конфликтов нет» и не выполняется ошибочная конверсия расстояния.
- Убрано повторное увеличение UnknownVertical для одного пересечения. Подсчёт пересечений/сближений выполняется в одном месте, сохраняются handles обеих сторон.
- Удаление близких точек графа теперь учитывает Z, а не только XY. Перевод расстояний в метры уже был в v0.20; исправление касается именно потери вертикальных отрезков.
- Замкнутые кривые сохраняются как петли с полной длиной и двумя инцидентностями, вместо исчезновения после совпадения начала и конца.
- Кривые с одинаковыми концами больше не объявляются возможными дублями только по концам. Эта эвристика ограничена прямыми LINE внутри одной группы. Порог перепада Z переводится в метры.
- Настраиваемая NSS_REPORT_DIR позволяет направить диагностические отчёты в выбранную папку. Build-NssEngine.ps1 больше не перезаписывает csproj и не удаляет каталог сборки.
- Добавлена NSS_SELFTEST с четырьмя интеграционными сценариями на временных базах: неизвестные единицы, один конфликт с неизвестной Z, окружность-петля, вертикальный отрезок.

Фактическая финальная сборка DLL: 0 ошибок, 0 предупреждений. Команда: dotnet build AutoCAD_Project_v0.18/NssEngine.csproj -c Release -o build_check -p:NuGetAudit=false. Сетевой аудит уязвимостей NuGet отключён и НЕ проверен. Исправления C# подтверждены компиляцией; их выполнение в AutoCAD и NSS_SELFTEST ещё НЕ подтверждены.

## Почему весь AutoCAD-продукт пока не объявлен исправным

AutoCAD Core Console 2026 действительно запускалась. Обычный запуск завершился с «Problem with setting up current profile» до NETLOAD. Повтор с /isolate NSS_Engine_Test <рабочая папка профиля> завершился с «Can't open HKCU ... Acad root registry key (2)» и «Failed to create registry keys or files necessary when using the /isolate switch». Логи и подготовленный тестовый DXF сохранены в RuntimeEvidence. Следовательно, DLL не была загружена, команды не выполнялись.

Доступ к интерфейсу через computer-use: native pipe unavailable, os error 2. Проверка локального HTML через браузер: iab unavailable. Дальнейшая проверка AutoCAD требует среды с корректно инициализированным профилем AutoCAD и доступным рабочим сеансом. Реестр, политики безопасности и профили пользователя не изменялись. NSS_SELFTEST подготовлена, чтобы после восстановления среды получить проверяемый машинный результат, а не субъективное подтверждение.

Прямой вызов нового Build-NssEngine.ps1 блокируется действующей ExecutionPolicy. Политика не обходилась и не менялась; рабочая команда dotnet выполнена напрямую. Интерактивный ввод пути при двойном щелчке и перетаскивание папки не проверены через UI; проверен вызов Run-NSS.cmd с аргументом папки.

## Выполненные команды и материалы

```text
Copy-Item work/NSS_RealDXF_v0.20 work/NSS_RealDXF_v0.21 -Recurse
accoreconsole.exe /i <smoke.dxf> /s <smoke.scr> /l en-US
accoreconsole.exe /?
accoreconsole.exe /i <smoke.dxf> /s <smoke.scr> /isolate NSS_Engine_Test <profile> /l en-US
../py312/Scripts/python.exe run_checks.py
../py312/Scripts/python.exe nss_engine.py --out Results_v021 <четыре DXF>
dotnet build AutoCAD_Project_v0.18/NssEngine.csproj -c Release -o build_check -p:NuGetAudit=false
Run-NSS.cmd --check
Run-NSS.cmd ../..
python.exe -m compileall -q nss_engine.py nss_geometry_v021.py
work/py312/Scripts/python.exe work/package_v021.py
```

Исходный zip v0.18 по-прежнему отсутствует. Исторические файлы v0.18–v0.20 сохранены, они не являются результатом новой проверки. Доказательства: checks_v021.log, portable_checks_v021.log, analysis_v021.log, portable_analysis_v021.log, build_v021.log; diff C# — changes_v021.patch. Полный список исходников и бинарных файлов с хешами — MANIFEST_v021_SHA256.json. ZIP проверяется по CRC и по всем записям манифеста. Итоговая проверка распакованного ZIP с самодостаточным runtime записывается рядом с архивом в output/verification_v021.log.

Проверен работающий самостоятельный анализатор DXF. Полноценный плагин AutoCAD остаётся на этапе интеграционной проверки из-за указанных препятствий среды; объявлять весь NSS Engine готовым инженерным продуктом оснований пока нет.
'''
(p/'REPORT_v021_RU.md').write_text(report,encoding='utf8')
skip={'__pycache__','obj','bin','wheelhouse','Reports'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and f.name!='MANIFEST_v021_SHA256.json']
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_v021_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
files.append(p/'MANIFEST_v021_SHA256.json')
archive=root/'output/NSS_Engine_v0.21_Portable.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files):z.write(f,'NSS_Engine_v0.21/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,digest in manifest.items():assert hashlib.sha256(z.read('NSS_Engine_v0.21/'+name)).hexdigest()==digest
(root/'output/SHA256_v021.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
shutil.copy2(p/'REPORT_v021_RU.md',root/'output/REPORT_v021_RU.md')
print('ZIP OK:',archive.stat().st_size,'bytes;',len(files),'files')

