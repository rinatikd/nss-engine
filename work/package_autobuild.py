from pathlib import Path
import hashlib
import json
import shutil
import zipfile

root=Path(__file__).resolve().parents[1]
p=root/'work/NSS_AutoBuild_v023'
def sha(path):
    with path.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

evidence=p/'Evidence';evidence.mkdir(exist_ok=True)
rows=[]
for run in sorted((p/'Runs').iterdir()):
    if not (run/'status.json').is_file():continue
    state=json.loads((run/'status.json').read_text(encoding='utf8'))
    shutil.copytree(run,evidence/run.name,dirs_exist_ok=True)
    log=(run/'build.log').read_bytes().decode('utf8',errors='replace')
    assert 'NssEngine.dll' in log
    rows.append({'run':run.name,'phase':state['phase'],'mode':state['mode'],
        'run_id':state['run_id'],'host_exit_code':state.get('host_exit_code'),
        'dll_sha256':state.get('dll_sha256')})
assert any(r['phase']=='PREPARED' for r in rows)
assert any(r['phase']=='HOST_EXITED_WITHOUT_REPORTS' for r in rows)
assert any(r['phase']=='TIMEOUT' for r in rows)
assert not any(r['phase']=='PASSED' for r in rows)
table='\n'.join(f"| {r['run']} | {r['mode']} | {r['phase']} |" for r in rows)
report='''# NSS AutoBuild v0.23 — результаты проверки

Дата: 16.10.2026. Автосборка подготовлена в отдельной папке work/NSS_AutoBuild_v023. Проект v0.23 и исходные DXF не изменены. В комплекте — исходники C#, переносимый Python, автозапуск, тесты и логи.

## Что подготовлено

Build-And-Run.cmd запускает autobuild.py, который собирает DLL, создаёт уникальную папку запуска, тестовый DXF или копию входного файла, ASCII SCR для NETLOAD, NSS_SELFTEST и NSS_EXPORT_DIAGNOSTICS, затем запускает AutoCAD GUI или Core Console. Путь DLL и id проверки передаются переменными дочернего процесса. Отчёты направляются в папку этого запуска. Другие процессы AutoCAD не закрываются, политики безопасности не изменяются.

Успех требует четырёх известных тестов, версии DLL 0.23.1.0, свежих JSON/TXT с правильным runId, ожидаемого имени чертежа, корректной сводки диагностики и сохранности копии/DLL. Старый JSON, частичный экспорт и успешный запуск процесса сами по себе не дают PASSED. На стандартном тестовом DXF дополнительно требуются две распознанные группы и два объекта.

В C# добавлены runId и версия сборки в JSON самопроверки, runId в диагностический экспорт; версия DLL изменена на 0.23.1.0 для различения проверяемого комплекта. Алгоритмы Python v0.23 не переносились в DLL.

## Фактические результаты

- 14 unit-тестов запускателя прошли; compileall — успешно.
- Все реальные сборки завершились с 0 ошибками и предупреждениями против установленного AutoCAD 2026 API. Использован .NET SDK 10.0.401, целевая платформа net8.0-windows. Сетевой аудит NuGet отключён и не проверен.
- Выполнены попытки Core Console и GUI. Core Console завершилась с кодом 1 из-за Problem with setting up current profile до NETLOAD. GUI не создала отчёты за 90 секунд; процесс оставлен для завершения пользователем стартовых диалогов.
- Канал native computer-use недоступен (os error 2), поэтому визуальная проверка окон AutoCAD не состоялась.
- После уточнения документации формат SCR заменён с UTF-8 BOM на ASCII; DLL-путь передаётся через NSS_PLUGIN_DLL. Итоговая подготовка и повторный Core-запуск выполнены, но Core снова остановился на профиле. Итоговый SCR внутри AutoCAD не исполнен.

| Запуск | Режим | Состояние |
|---|---|---|
'''+table+'''

Ни один реальный запуск не получил PASSED. Это не объявляется успешной работой в AutoCAD. Нужен работоспособный пользовательский профиль AutoCAD; дальнейшая проверка выполняется через корневой Build-And-Run.cmd. При запоздавшем завершении той же GUI-сессии доступен --collect <папка запуска>.

Основные выполненные команды:

```text
runtime/python.exe -E -s -X utf8 -m unittest -v test_autobuild
Build-And-Run.cmd --mode core --timeout 60
Build-And-Run.cmd --mode gui --timeout 90
Build-And-Run.cmd --mode prepare
Build-And-Run.cmd --mode core --timeout 30
runtime/python.exe -m compileall -q autobuild.py test_autobuild.py
work/py312/Scripts/python.exe work/package_autobuild.py
```

У каждого реального запуска status.json содержит точные build_command и launch_command, а build.log/host.log содержат вывод процессов. Отдельная итоговая сборка в режиме prepare также выполнена. Каталог Evidence — история текущей среды с абсолютными путями, не каталог для повторного запуска после распаковки. Новый запуск создаёт чистый Runs. После упаковки проверяются CRC и SHA-256 содержимого, затем тесты запускателя повторяются из распакованного ZIP; результат — output/verification_autobuild.log.

## Непроверенное

Выполнение NSS_SELFTEST и диагностического экспорта внутри AutoCAD пока не подтверждено. Не проверены UI/все команды плагина, инженерные нормы и перенос алгоритма раскрытия блоков в C#. Не менялись профиль, реестр, SECURELOAD, TRUSTEDPATHS и ExecutionPolicy. Интерактивный двойной щелчок по CMD не проверялся через UI; командный вызов CMD реально выполнен. Обработка доверия DLL и стартовых диалогов остаётся пользователю.

Порядок запуска и коды завершения — README_RU.md.
'''
(p/'REPORT_RU.md').write_text(report,encoding='utf8')
(p/'attempts.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8')
skip={'__pycache__','obj','bin','Runs'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and f.name!='MANIFEST_SHA256.json']
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_AutoBuild_v0.23.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for f in sorted(files):z.write(f,'NSS_AutoBuild_v023/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,digest in manifest.items():assert hashlib.sha256(z.read('NSS_AutoBuild_v023/'+name)).hexdigest()==digest
(root/'output/SHA256_AutoBuild.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
shutil.copy2(p/'REPORT_RU.md',root/'output/REPORT_AutoBuild_RU.md')
print('ZIP verified:',archive.stat().st_size,'bytes;',len(files),'files')
