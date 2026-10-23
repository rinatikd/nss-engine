from pathlib import Path
import hashlib,json,shutil,sys,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_AutoDebug_v0422'
def sha(f):
 with f.open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
e=p/'Evidence';e.mkdir(exist_ok=True)
for n in ('host_tests_v0422.log','build_v0422.log','contract_tests_v0422.log','prepare_inhost_v0422.log','prepare_prebuilt_v0422.log'):shutil.copy2(p/n,e/n)
for f in (p/'Runs').glob('*/status.json'):
 state=json.loads(f.read_text(encoding='utf8'));assert state['phase']=='PREPARED'
 kind='prebuilt' if state['offline']['build'].startswith('NOT_RUN') else 'in_host_build'
 dest=e/('prepared_'+kind);dest.mkdir(exist_ok=True)
 for x in f.parent.glob('*'):
  if x.is_file() and x.suffix in ('.log','.json','.scr','.lsp','.html'):shutil.copy2(x,dest/x.name)
prior=root/'work/NSS_AutoDebug_v0421/Runs/20261020_103620_ebb6c708'
dest=e/'Actual_host_failure_v0421_20261020';dest.mkdir(exist_ok=True)
for n in ('status.json','host.log','python-tests.log','RESULT.html'):shutil.copy2(prior/n,dest/n)
sys.path.insert(0,str(p))
from nss_engine.host_diagnostics_v0422 import diagnose
state=json.loads((prior/'status.json').read_text(encoding='utf8'))
diagnosis=diagnose((prior/'host.log').read_bytes(),state['host_exit_code'],False)
assert diagnosis['code']=='HOST_TEMP_DIRECTORY_ERROR' and not diagnosis['plugin_failure_confirmed']
(dest/'diagnosis.json').write_text(json.dumps(diagnosis,ensure_ascii=False,indent=2),encoding='utf8')
(p/'README.md').write_text('''# NSS AutoDebug v0.42.2

Продолжение отладки запуска AutoCAD. Полный native-прогон пока не подтверждён. Сборка DLL, 260 Python-тестов и 18 C# проверок прошли; новая резервная загрузка проверена компиляцией и генерацией, но не выполнением в AutoCAD.

## Основной запуск

Закройте предыдущий тестовый AutoCAD, сохранив нужные изменения. Распакуйте весь комплект и запустите START_NSS_AUTOTEST.cmd двойным щелчком. Как прежде, сценарий сам соберёт DLL (либо проверит комплектную DLL без SDK), создаст тестовый DXF, запустит новый AutoCAD и дождётся всех 14 native проверок и Python. Весь результат — RESULT.html и *_diagnostics.zip в Runs. Никаких отдельных команд по-прежнему вводить не нужно.

## Если AutoCAD не запускается из сценария

1. Откройте обычным способом НОВЫЙ сеанс AutoCAD 2026, без ранее загруженной старой NSS DLL. Предыдущие рабочие документы не закрывать без сохранения.
2. Запустите START_IN_AUTOCAD.cmd. После подготовки он выведет путь к RUN_IN_AUTOCAD.lsp и будет ждать до 10 минут.
3. Перетащите RUN_IN_AUTOCAD.lsp из внутренней папки NSS_AutoDebug_v0422 в окно AutoCAD. Это ОДИН загрузочный файл для всего прогона, не серия ручных тестов. Он сам выполнит SCRIPT с открытием только созданного fixture_copy.dxf, NETLOAD и полной проверкой.

Ничего вводить в командную строку, выбирать JSON или подтверждать каждый тест не требуется. Резервная загрузка не меняет FILEDIA, SECURELOAD, профиль или registry. Тестовая команда проверяет путь/UUID/SHA-256 перед работой. Preview-мутации происходят только в отдельной disposable Database; текущий чертёж используется для read-only экспорта.

Если окно ожидания уже закрылось, запустите COLLECT_LAST_RESULT.cmd — отчёты последнего прогона будут проверены и собраны повторно. Не нужно снова выполнять тестовые команды. По окончании достаточно сообщить «готово»: если Runs осталась в общей папке NSS_Engine, отчёты можно прочитать непосредственно.

PASSED допускается только после проверки всех native cases, версии/SHA DLL, исходника/DBMOD и Python. PREPARED и WAITING_FOR_IN_HOST_TEST не являются успехом. Ошибка host startup не объявляется ошибкой DLL без native evidence. Код — autocad/nss_engine/scripts, тесты — tests/contract_tests, фактические результаты — Evidence. Подробности — REPORT_AUTODEBUG_v0422_RU.md.
''',encoding='utf8')
(p/'REPORT_AUTODEBUG_v0422_RU.md').write_text('''# NSS AutoDebug v0.42.2 — 20.10.2026

Цель этапа — продолжить разработку с реальных результатов автоматического тестирования, не увеличивая число ручных действий пользователя. Проверены текущая папка и каталоги отчётов: нового native_results.json от v0.42.1 нет, сохранены только PREPARED и реальные export/Python evidence v0.42 из пользовательского сеанса.

## Фактическое воспроизведение

Выполнено из work/NSS_AutoDebug_v0421:

```text
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --use-prebuilt --timeout 45
```

Run 20261020_103620_ebb6c708: 252 Python-теста прошли, использована проверенная комплектная DLL 0.42.1, новая сборка и C# harness при --use-prebuilt намеренно не запускались. AutoCAD завершился code 3221225477 (0xC0000005), не создав native отчёта. host.log: Cannot get temporary directory long path name. Это воспроизводимый сбой запуска хоста из текущей среды; подтверждения NETLOAD и выполнения DLL нет. Нельзя по этому журналу заключить, что ошибка внутри NSS. Контекст и полный журнал сохранены в Evidence/Actual_host_failure_v0421_20261020.

## Изменения

- host_diagnostics_v0422.py различает ошибку TEMP, настройки профиля, неизвестный выход и отсутствие отчёта; читает UTF-8/UTF-16/BOM, сохраняет ограниченный фрагмент журнала и не присваивает DLL неподтверждённую вину.
- HTML/JSON автоматического запуска содержат host diagnosis и путь резервного загрузчика.
- Добавлен --in-host и Start-In-AutoCAD.cmd: подготовка, генерация полного SCRIPT и ожидание результата из обычного AutoCAD. Один LISP-файл запускает SCRIPT, который открывает только наш синтетический DXF, загружает DLL и вызывает NSS_AUTOTEST_FILE_V042 с конкретным authorization.json.
- Добавлен .NET LispFunction bootstrap: временно устанавливает NSS_REPORT_DIR/UUID только в окружении текущего процесса, выполняет ту же guarded native suite, затем восстанавливает исходные значения через finally. Профиль/registry не изменяются. Дочерний Python получает нужное окружение при старте и пишет в явно выбранную Runs-папку.
- UUID, путь тестового файла, его SHA и SHA загруженной DLL проверяет прежняя native команда до тестов. Нет перехода к мутациям рабочего DWG.
- COLLECT_LAST_RESULT.cmd / --collect-last собирает поздний результат одной кнопкой, с ограничением указателя последнего запуска внутри Runs. Сохраняются те же строгие проверки 14 cases, snapshot, Python, DBMOD, версии DLL.
- Сборка теперь 0.42.2.0; старые сборки не выдаются за прошедшие новый прогон.

## Почему SCRIPT, а не ActiveX Open для DXF

SCRIPT выполняет последовательность команд ([Autodesk SCRIPT](https://help.autodesk.com/cloudhelp/2025/ENG/AutoCAD-Core/files/GUID-DB55FE5C-6B51-40AE-AE3D-4C3A28ADC5D9.htm)); в активном скрипте FILEDIA не требует изменения ради командных аргументов ([Autodesk FILEDIA](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-Core/files/GUID-99736BD7-E60E-4F4A-83F7-436B6F9C67A1.htm)). Документация ActiveX Open ориентирована на DWG и направляет DXF к Import ([Autodesk Open](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-ActiveX-Reference/files/GUID-9ED7A548-7978-4BFD-8462-E2FA747E8880.htm)); поэтому здесь не добавлялось неподтверждённое открытие DXF через COM. Документированная возможность не равна native проверке нашего конкретного загрузчика.

## Фактически проверено для v0.42.2

```text
runtime/python.exe -E -s -X utf8 -m unittest discover -s tests -v
dotnet run --project contract_tests/ContractTests.csproj -p:NuGetAudit=false -- contract_fixture_v042.json
dotnet build autocad/NssEngine.Export.csproj -c Release -o Deploy "-p:AutoCADDir=C:\\Program Files\\Autodesk\\AutoCAD 2026" -p:NuGetAudit=false --nologo
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --prepare --in-host
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --prepare --use-prebuilt
```

260 Python-тестов и 18 C# проверок прошли. 8 новых Python-тестов проверяют причины отказа, UTF-16/BOM/Unicode, отсутствие ложного plugin verdict, ограничение excerpt, Unicode/пробелы/кавычки в генераторе, отсутствие SAVE/QUIT/setvar/setenv/SECURELOAD в резервном сценарии. Сборка с AutoCAD 2026 references: 0 ошибок и 0 предупреждений. Оба подготовительных режима прошли, созданы SCR/LSP/авторизация/HTML/диагностический ZIP. PREPARED нигде не трактуется как PASSED.

Новая DLL, новый LispFunction и последовательность SCRIPT через открытие документа ещё НЕ выполнены в AutoCAD. Визуальный интерфейс, full native 14 cases и сохранность окружения в хосте ожидают реального прогона. По предыдущей v0.42 пользователь уже подтвердил экспорт и Python; новый тест этим не считается пройденным. Синтетические JSON тестов сборщика остаются unit fixtures, не native evidence.

Исходные четыре DXF и старые версии сохранены. Геометрический анализ реальных проектов в этом этапе не менялся и заново не выполнялся. Функциональность 0.42.1 не расширялась новыми проектными возможностями до завершения native gate. Лимиты/3D/Xref/нормативные ограничения прежние. SDK и Autodesk DLL не включены, Python runtime включён; NuGetAudit=false, сетевой аудит пакетов не выполнялся.

Комплект содержит полный исходный код, тесты, DLL, инструкции и фактическое failure evidence. ZIP проверяется CRC/SHA-256; повторная подготовка из извлечённого архива записывается в output/verification_autodebug_v0422.log.
''',encoding='utf8')
shutil.copy2(p/'REPORT_AUTODEBUG_v0422_RU.md',root/'output/REPORT_AutoDebug_v0.42.2_RU.md')
skip={'obj','bin','__pycache__','Runs','validation_v042'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and (len(f.relative_to(p).parts)>1 or f.suffix!='.log') and f.name not in ('MANIFEST_SHA256.json','LAST_RUN.json','RUN_IN_AUTOCAD.lsp')]
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_AutoDebug_v0.42.2.zip'
wrappers={'START_NSS_AUTOTEST.cmd':'Start-AutoDebug.cmd','START_IN_AUTOCAD.cmd':'Start-In-AutoCAD.cmd','COLLECT_LAST_RESULT.cmd':'Collect-Last-Result.cmd'}
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for name,target in wrappers.items():z.writestr(name,'@echo off\r\ncall "%~dp0NSS_AutoDebug_v0422\\'+target+'" %*\r\nexit /b %errorlevel%\r\n')
 z.writestr('README_RU.txt','Основной запуск: START_NSS_AUTOTEST.cmd. Если автоматический запуск AutoCAD не работает: откройте новый AutoCAD обычным способом, запустите START_IN_AUTOCAD.cmd и перетащите появившийся NSS_AutoDebug_v0422/RUN_IN_AUTOCAD.lsp в AutoCAD. Все проверки затем выполняются автоматически. COLLECT_LAST_RESULT.cmd собирает поздние результаты. Подробности: NSS_AutoDebug_v0422/README.md.')
 for f in sorted(files):z.write(f,'NSS_AutoDebug_v0422/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for n,d in manifest.items():assert hashlib.sha256(z.read('NSS_AutoDebug_v0422/'+n)).hexdigest()==d
 z.extractall(root/'output/NSS_AutoDebug_v0.42.2_Verified')
(root/'output/SHA256_AutoDebug_v0422.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
print('ZIP CRC/SHA verified:',archive,archive.stat().st_size)
