# Chrome Bridge Recovery Native Messaging Host

Независимый от остановленного Node/MCP/tunnel локальный помощник Windows. Реализован на .NET 8; Chrome запускает его по протоколу Native Messaging (4-байтная длина + UTF-8 JSON).

**Доступный интерфейс:** только один объект `{"action":"status"}` или `{"action":"restore"}`. Файлы, рабочие каталоги, аргументы процесса, токены, ID сервиса, произвольные PowerShell-команды из расширения не принимаются.

После получения допустимой команды запускается фиксированный скрипт:
`C:\Engineering\ChromeBridge-Recovery-Release\Invoke-VerifiedRecovery.ps1`
с одним фиксированным аргументом режима. Скрипт проверяет SHA256-манифест release, затем вызывает локальный штатный восстановитель. 110 секунд — верхняя граница ожидания хоста. Ответ возвращает только ограниченные идентификаторы/статусы и никогда не содержит вывод ошибок PowerShell с секретами.

## Подключение к браузеру

`Install-RecoveryNativeHost.ps1` регистрирует только в **HKCU**:
`Software\Google\Chrome\NativeMessagingHosts\com.chrome_bridge.recovery`.

`allowed_origins` разрешён только одному проверенному PR113 LAB ID:
`chrome-extension://ehmllfabjbfcinaigionjggbgonkokfg/`.

Для новой сборки с другим extension ID требуется отдельный локальный аудит и повторная установка регистрационного манифеста с явным согласованием нового ID. Нельзя автоматически разрешать `*` и нельзя прокидывать Native Messaging через внешний веб-сайт или удалённый MCP.

## Порядок внедрения

1. Изолированная копия платформенного PR #110; `node --test tools/ai_collaboration/recovery/*.test.mjs`, далее сборка host через `dotnet publish` и тест Native Messaging protocol на Windows.
2. `Prepare-RecoveryRelease.ps1` создаёт новый отдельный каталог `C:\Engineering\ChromeBridge-Recovery-Release` без замены существующих сервисов.
3. Проверить `Invoke-VerifiedRecovery.ps1 -Mode Verify`, затем `-Mode Status`. Сверить PID/скрипты/порты.
4. Для восстановления туннелей один раз локально выполнить `Save-RecoveryCredential.ps1` со скрытым вводом существующего ключа Control Plane (никогда не отправлять его в чат). Проверить DPAPI.
5. Из чистого checkout: `Install-RecoveryNativeHost.ps1 -Mode Check`; затем только после утверждения `-Mode Install`. Сборка `win-x64` self-contained (может потребовать доступ к .NET targeting/runtime packs); registry не перезаписывается, если уже существует.
6. Обновить PR113 LAB расширение по **сохранённому ID**; проверить кнопку `Восстановить службы Windows` в состоянии всех служб уже включены (не должно появиться новых PID).
7. Проверить контролируемо остановленный независимый PR102 LAB в изолированном тестовом окне и восстановление (без production). Затем проверить действительную связь ChatGPT `browser_status`, не только TCP.
8. Регистрация задач Windows после E2E — отдельно: `Register-StackRecovery.ps1 -Mode Check`, далее `-Mode Register -DesktopShortcut`. Разрешён обратный `-Mode Unregister`. Не делать перезагрузку рабочего ПК для проверки без отдельного плана отката.

## Ограничения

- Невозможно «первоначально установить себя» одним нажатием расширения: Chrome специально требует предварительно зарегистрированный локальный Native Messaging Host. Это одноразовая установка в Windows.
- Отдельные production и неизвестные tunnel-профили не запускаются до согласованной инвентаризации. RC1 Lab и Workbench пока STATUS ONLY.
- Наличие процесса или TCP-порта не означает работоспособность MCP, Chrome session или успешную авторизацию.
- Файлы и регистрация должны находиться в контролируемом каталоге с ограниченными NTFS ACL. SHA256 сам по себе не заменяет подпись/привязку к доверенному источнику.
- UI PR113 остаётся двукнопочным для соединения Bridge; дополнительная независимая кнопка восстановления не заменяет Connect/Disconnect и не отключает их.
