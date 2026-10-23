# NSS AutoDebug v0.42.2 — 20.10.2026

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
dotnet build autocad/NssEngine.Export.csproj -c Release -o Deploy "-p:AutoCADDir=C:\Program Files\Autodesk\AutoCAD 2026" -p:NuGetAudit=false --nologo
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --prepare --in-host
runtime/python.exe -E -s -X utf8 scripts/autodebug_v0421.py --prepare --use-prebuilt
```

260 Python-тестов и 18 C# проверок прошли. 8 новых Python-тестов проверяют причины отказа, UTF-16/BOM/Unicode, отсутствие ложного plugin verdict, ограничение excerpt, Unicode/пробелы/кавычки в генераторе, отсутствие SAVE/QUIT/setvar/setenv/SECURELOAD в резервном сценарии. Сборка с AutoCAD 2026 references: 0 ошибок и 0 предупреждений. Оба подготовительных режима прошли, созданы SCR/LSP/авторизация/HTML/диагностический ZIP. PREPARED нигде не трактуется как PASSED.

Новая DLL, новый LispFunction и последовательность SCRIPT через открытие документа ещё НЕ выполнены в AutoCAD. Визуальный интерфейс, full native 14 cases и сохранность окружения в хосте ожидают реального прогона. По предыдущей v0.42 пользователь уже подтвердил экспорт и Python; новый тест этим не считается пройденным. Синтетические JSON тестов сборщика остаются unit fixtures, не native evidence.

Исходные четыре DXF и старые версии сохранены. Геометрический анализ реальных проектов в этом этапе не менялся и заново не выполнялся. Функциональность 0.42.1 не расширялась новыми проектными возможностями до завершения native gate. Лимиты/3D/Xref/нормативные ограничения прежние. SDK и Autodesk DLL не включены, Python runtime включён; NuGetAudit=false, сетевой аудит пакетов не выполнялся.

Комплект содержит полный исходный код, тесты, DLL, инструкции и фактическое failure evidence. ZIP проверяется CRC/SHA-256; повторная подготовка из извлечённого архива записывается в output/verification_autodebug_v0422.log.
