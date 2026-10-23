from pathlib import Path
import hashlib,json,shutil,zipfile
root=Path(__file__).resolve().parents[1];p=root/'work/NSS_AutoDebug_v0421'
def sha(f):
 with f.open('rb') as s:return hashlib.file_digest(s,'sha256').hexdigest()
history=p/'History';history.mkdir(exist_ok=True)
for f in list(p.glob('*.md')):
 if f.name!='README.md':shutil.move(str(f),str(history/f.name))
e=p/'Evidence';e.mkdir(exist_ok=True)
for name in ('autodebug_tests.log','autodebug_build.log','contract_tests_autodebug.log','prepare_autodebug.log','prebuilt_prepare_autodebug.log'):shutil.copy2(p/name,e/name)
runs=list((p/'Runs').glob('*/status.json'))
for status in runs:
 data=json.loads(status.read_text(encoding='utf8'));assert data['phase']=='PREPARED'
 prefix='prebuilt' if data['offline']['build'].startswith('NOT_RUN') else 'build'
 dest=e/('prepared_'+prefix);dest.mkdir(exist_ok=True)
 for f in status.parent.glob('*'):
  if f.is_file() and f.suffix in ('.json','.log','.html','.scr'):shutil.copy2(f,dest/f.name)
for name in ('AutoCAD_v042_20261019_120702_Verified','AutoCAD_v042_PythonBridge_Verified'):
 source=root/'output'/name
 if source.exists():shutil.copytree(source,e/'Previous_v042'/name,dirs_exist_ok=True)
(p/'README.md').write_text('''# NSS AutoDebug v0.42.1 — один запуск вместо ручных команд

**Закройте предыдущий тестовый AutoCAD после сохранения нужных изменений.** Распакуйте весь ZIP в отдельную папку и дважды щёлкните START_NSS_AUTOTEST.cmd рядом с этой инструкцией. Не требуется вводить NETLOAD, выбирать JSON или подтверждать каждую проверку. При открытом старом NSS новый DLL может не загрузиться — именно поэтому нужен новый тестовый процесс.

Сценарий проверит Python-код, соберёт свежую DLL при наличии SDK (либо использует проверенную комплектную DLL, если SDK отсутствует), создаст девятиобъектный DXF, запустит AutoCAD 2026 и выполнит весь регрессионный прогон. Только в отдельной базе в памяти проверяются запись/очистка/rollback preview. Активная тестовая копия используется для read-only экспорта и Python; рабочие DWG не открываются и не сохраняются. Системные профили, SECURELOAD, ExecutionPolicy не меняются.

В окне запуска появятся пути RESULT.html и *_diagnostics.zip внутри NSS_AutoDebug_v0421/Runs. Дождитесь итога (тайм-аут по умолчанию 180 секунд после запуска AutoCAD). **Пришлите только напечатанный *_diagnostics.zip** — все команды и JSON уже собраны. AutoCAD принудительно не закрывается.

PASSED означает, что прошли 14 native проверок и проверен результат фонового Python на известном примере, версия/хэш DLL, исходный DXF и DBMOD. PREPARED — только подготовка, TIMEOUT_NOT_VERIFIED/HOST_EXITED_WITHOUT_COMPLETE_REPORTS/FAILED — неуспех или отсутствие достаточных данных. Это не инженерная приёмка реального проекта.

Фактически перед упаковкой пройдены 252 Python-теста, 18 C# проверок; DLL .NET 8 x64 версии 0.42.1.0 собрана с AutoCAD 2026 references без ошибок и предупреждений. Новые 14 native проверок в AutoCAD пока НЕ выполнены. Предыдущая v0.42 успешно экспортировала fixture и запускала Python в пользовательском AutoCAD; это подтверждение хранится отдельно и не выдаётся за успех новой suite.

Опции для разработчика (обычному запуску не нужны): Start-AutoDebug.cmd --prepare; --use-prebuilt; --timeout 300; --autocad-dir "C:\\Program Files\\Autodesk\\AutoCAD 2026". --collect "полный путь Runs/папка" повторно соберёт поздно появившиеся отчёты. Подробности — REPORT_AUTODEBUG_RU.md. Исторические документы — History, источники C# — autocad, тесты — tests и contract_tests.
''',encoding='utf8')
(p/'REPORT_AUTODEBUG_RU.md').write_text('''# NSS AutoDebug v0.42.1 — фактический отчёт 19.10.2026

Запрос пользователя: убрать ручную проверку каждой команды и подготовить полноценный автоматический тестовый/отладочный код. Реализация продолжает v0.42 Release в отдельной work/NSS_AutoDebug_v0421; предыдущие исходники и комплект сохранены.

## Реализация

Start-AutoDebug.cmd и scripts/autodebug_v0421.py автоматически создают уникальную Runs-папку, выполняют офлайн проверки и сборку, готовят свежий девятиобъектный DXF, авторизацию теста с UUID/путём/хэшами, ASCII SCR с NETLOAD через getenv, затем запускают AutoCAD и NSS_AUTOTEST_V042 без файловых диалогов. Пакетная DLL .NET 8 версии 0.42.1.0 и SHA-256 позволяют проверить запуск без SDK; при доступном SDK по умолчанию выполняется сборка, её ошибка не маскируется старой DLL. Отдельный C# harness использует SDK 10; его отсутствие явно отмечается, target плагина остаётся net8.0-windows.

Native команда отказывается работать без корректной авторизации, на другом чертеже, при другом SHA исходника или DLL. Экспортирует только тестовую копию. Preview-тесты используют private disposable Database, не текущий DWG. Пользовательские подтверждения не обходятся для рабочих чертежей: интерактивные команды сохраняют Yes/No, автоматический confirmed=true применяется только к созданной тестовой базе в рамках разрешённого прогона.

PreviewServiceV042 вынесен из рабочих команд. И рабочие команды, и native suite выполняют одни и те же транзакции. Вынесен также PythonJobV042: тест использует реальный production bridge и реальный Python worker, без имитации отчёта. Исправлена привязка LayerId: слой берётся явно из переданной Database вместо разрешения имени через текущую WorkingDatabase, что нужно для безопасного side-database тестирования.

## 14 native проверок

1. Инвентаризация: 5 LINE, 2 LWPOLYLINE, 1 INSERT, 1 другой объект, ошибок чтения нет.
2. Реальный экспорт XYZ/bulge/атрибутов: 8 записей и 1 явный пропуск CIRCLE.
3. Active drawing и DBMOD не изменяются экспортом.
4. Отказ от preview не меняет объекты/слои private DB.
5. Некорректный preview отклоняется без записи.
6. Preview создаётся с NSS-маркером на non-plot слое.
7. Отказ от очистки ничего не меняет.
8. Очистка удаляет только owned preview, сохраняет чужую полилинию на том же слое.
9. Повторная очистка идемпотентна.
10. Искусственная ошибка после AppendEntity до Commit откатывает объекты и новый слой.
11. Совпадение с чужим plottable слоем приводит к отказу без изменения слоя/геометрии.
12. Active drawing не изменился после side DB тестов.
13. Файл fixture остался с исходной SHA-256.
14. Запущен настоящий production Python bridge.

После native стадии внешний сборщик дополнительно ждёт COMPLETED_REVIEW_REQUIRED Python, проверяет SHA snapshot/drawing identity, XYZ Z=2..7, bulge ±1/normal, CODE=ККС-1, распознавание (unknown=3, telecom=4, water=1), топологию (3 network segments, 1 utility, 1 candidate component), 1 дубликат и 2 плановых crossing. Физическое соединение и нормативное соответствие не должны объявляться подтверждёнными. Незавершённый bridge, изменённый DBMOD, не та DLL/UUID, отсутствующий/повторный case или неполный отчёт не дают PASSED.

Нативные мутации не проверяют пиксели интерфейса, клавиатурный ввод Yes/No, native UNDO или сохранение/повторное открытие рабочего DWG. Проверяется функциональная общая транзакционная служба, включая реальный rollback при ошибке. Это содержательная регрессия, не сертификация всех native сценариев.

## Фактически выполнено

```text
runtime/python.exe -E -s -X utf8 -m unittest discover -s tests -v
dotnet run --project contract_tests/ContractTests.csproj -p:NuGetAudit=false -- contract_fixture_v042.json
dotnet build autocad/NssEngine.Export.csproj -c Release -o Deploy "-p:AutoCADDir=C:\\Program Files\\Autodesk\\AutoCAD 2026" -p:NuGetAudit=false --nologo
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --prepare
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --prepare --use-prebuilt
```

252 Python-теста прошли (237 прежних +15 новых проверок сборщика), 18 C# контрактных проверок прошли. Новая DLL собрана: 0 ошибок, 0 предупреждений. Prepare с пересборкой и prepare с комплектной DLL прошли; созданы HTML и ZIP с правильным статусом PREPARED, не PASSED. Логи — Evidence. В тестах сборщика намеренно используются синтетические native JSON; они создаются только в TemporaryDirectory и не являются реальным подтверждением AutoCAD. Проверены stale UUID, неверные версия/SHA, пропущенные/повторные cases, скрытая ошибка native, незавершённый/ошибочный Python, выход пути за Runs, изменение входов/DBMOD, неверная топология и формирование ZIP/HTML при сбое.

Новые 14 проверок внутри AutoCAD 2026 пока НЕ запускались. Их реальный результат будет получен автоматически одним пользовательским запуском. В Evidence/Previous_v042 сохранены уже проверенные native export и Python dispatch старой v0.42 из пользовательского сеанса; успех новой 0.42.1 из этого не выводится. Из ограниченной среды прежние попытки запуска AutoCAD завершались до подтверждения NETLOAD, поэтому они не повторялись и не выдаются за успешный runtime test. Исходная геометрия DWG не редактировалась.

Архив комплекта проверен CRC/SHA-256, подготовительный прогон повторяется из распакованного ZIP. Его журнал — output/verification_autodebug_v0421.log. SDK и библиотеки Autodesk не распространяются; Python runtime включён. NuGetAudit=false: сетевой аудит пакетов не выполнялся. Пределы обработки реальных DWG/3D/Xref/нормативов прежней v0.42 остаются; автотест не превращает их в реализованные функции.
''',encoding='utf8')
shutil.copy2(p/'REPORT_AUTODEBUG_RU.md',root/'output/REPORT_AutoDebug_v0.42.1_RU.md')
skip={'obj','bin','__pycache__','Runs','validation_v042'}
files=[f for f in p.rglob('*') if f.is_file() and not any(x in skip for x in f.relative_to(p).parts) and (len(f.relative_to(p).parts)>1 or f.suffix!='.log') and f.name!='MANIFEST_SHA256.json']
manifest={f.relative_to(p).as_posix():sha(f) for f in files}
(p/'MANIFEST_SHA256.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8');files.append(p/'MANIFEST_SHA256.json')
archive=root/'output/NSS_AutoDebug_v0.42.1.zip'
wrapper='@echo off\r\ncall "%~dp0NSS_AutoDebug_v0421\\Start-AutoDebug.cmd" %*\r\nexit /b %errorlevel%\r\n'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 z.writestr('START_NSS_AUTOTEST.cmd',wrapper)
 z.writestr('README_RU.txt','Закройте предыдущий тестовый AutoCAD, распакуйте всё и запустите START_NSS_AUTOTEST.cmd двойным щелчком. Все проверки автоматические. После завершения пришлите напечатанный *_diagnostics.zip. Подробности: NSS_AutoDebug_v0421/README.md.')
 for f in sorted(files):z.write(f,'NSS_AutoDebug_v0421/'+f.relative_to(p).as_posix())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for n,d in manifest.items():assert hashlib.sha256(z.read('NSS_AutoDebug_v0421/'+n)).hexdigest()==d
 z.extractall(root/'output/NSS_AutoDebug_v0.42.1_Verified')
(root/'output/SHA256_AutoDebug_v0421.txt').write_text(sha(archive)+'  '+archive.name+'\n',encoding='utf8')
print('AutoDebug ZIP CRC/SHA verified:',archive,archive.stat().st_size)
