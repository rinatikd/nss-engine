# NSS AutoDebug v0.42.3

Исправление конфликта загруженной сборки. Сборка и автономные тесты прошли; работа этой версии внутри AutoCAD пока не подтверждена.

1. Распакуйте весь ZIP в отдельную папку. Откройте AutoCAD 2026 обычным способом. Сохраните несохранённые рабочие документы.
2. Запустите внешний START_IN_AUTOCAD.cmd двойным щелчком. Дождитесь сообщения с путём к RUN_IN_AUTOCAD.lsp. Окно оставьте открытым.
3. Перетащите только что созданный NSS_AutoDebug_v0423/RUN_IN_AUTOCAD.lsp в окно AutoCAD.
4. Дождитесь результата в окне запуска. Все проверки выполняются автоматически. RESULT.html и *_diagnostics.zip находятся в NSS_AutoDebug_v0423/Runs. Если окно ожидания закрыто, COLLECT_LAST_RESULT.cmd повторно соберёт результат.

Вручную NETLOAD и тестовые команды вводить не требуется. При наличии .NET SDK каждое выполнение собирает DLL с новым именем, поэтому ранее загруженная NSS DLL не должна мешать загрузке этой тестовой сборки. Без SDK используется комплектная версия с отдельным именем; произвольная замена уже загруженной DLL с тем же именем не поддерживается. При таком конфликте нужен новый сеанс AutoCAD после сохранения документов.

Открывается только тестовый DXF. Изменения preview выполняются в отдельной временной Database. Исходные чертежи не изменяются. Запуск START_NSS_AUTOTEST.cmd предназначен для полностью автоматического открытия отдельного AutoCAD; в данной среде этот способ ранее завершался до запуска тестов, поэтому рекомендован START_IN_AUTOCAD.cmd.

Исходники: autocad, nss_engine, scripts. Тесты: tests, contract_tests. Собранная DLL: Deploy/NssEngine.AutoDebug.V0423.dll. Инструкция сборки, фактические результаты и ограничения: REPORT_AUTODEBUG_v0423_RU.md. Старые отчёты относятся к указанным в них версиям.

Проверка исходников без AutoCAD (из этого каталога):

```text
dotnet run --project contract_tests/ContractTests.csproj -p:NuGetAudit=false -- <temporary-directory>/contract_fixture_v042.json
python -X utf8 scripts/run_portable_tests.py --contract-fixture <temporary-directory>/contract_fixture_v042.json
```

Нужны .NET SDK 8, Python и зависимость `ezdxf` (версия зафиксирована в корневом `requirements-test.txt`). C# проверяет чистые контракты на синтетическом preview; Python дополнительно читает созданный C# snapshot. Без `--contract-fixture` Python запускается отдельно, но проверка межъязыкового snapshot может быть пропущена. Переносимый runner включает проверки сборщика результатов `test_autodebug_v0421` на синтетических отчётах; это не исполнение команд AutoCAD. Исключён только `test_v037` (нужны локальные examples snapshot/plan).

Текущий нативный сценарий — `scripts/autodebug_v0421.py` и команды запуска выше. Из чистого клона он создаёт синтетический DXF из исходников в новой папке `Runs/<id>`; отсутствующий `RuntimeFixture` не требуется, исходное дерево не пополняется чертежами. `--prepare` собирает отдельную DLL, проверяет контракты и регистрацию, создаёт fixture и загрузчик, затем завершает работу без запуска AutoCAD. Для сборки нужны SDK 8 и установленные ссылки AutoCAD 2026. `scripts/native_smoke_v042.py` — старый сценарий v0.42.0 с прежним именем DLL и проверкой прежней версии; для текущей v0.42.3 его не применять.

Полная автономная сборка на Windows: `python -X utf8 scripts/build_validate_v042.py --autocad-dir "C:\Program Files\Autodesk\AutoCAD 2026"`. Можно передать `--dotnet` с путём к SDK. Результат записывается в новый `validation_v042/<id>`: логи, межъязыковой snapshot, `plugin/NssEngine.AutoDebug.V0423.dll` и status.json. `PASSED` означает только автономные проверки и сборку; `autocad_runtime` остаётся `NOT_TESTED`. Сборка на Linux требует Windows targeting pack и `EnableWindowsTargeting=true` в окружении; это также не проверка работы внутри AutoCAD.
