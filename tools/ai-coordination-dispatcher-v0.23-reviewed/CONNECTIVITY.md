# Состояние подключения — 27.10.2026

## Проверено

- Настоящие Ollama executor/reviewer через MCP прошли Linux GitHub CI: [40517940935](https://github.com/rinatikd/nss-engine/actions/runs/40517940935). Арифметика проверена независимо; APPROVE с необязательными рекомендациями принимается.
- unified_runtime.py предоставляет UI и MCP один общий Application/worker. Оба интерфейса видят и останавливают один worker; реальные HTTP+MCP тесты проверяют оба направления.
- tunnel_connector.py формирует совместимый с официальным tunnel-client0.0.18 профиль без ключа. prepare/check локальны; doctor/run запускаются явно. Ключ — env reference либо скрытый локальный prompt. MCP child запускается с очищенным от tunnel/admin ключей окружением.
- Исходники опубликованы в agent/codex/a2a-interface-mcp-v016, main не изменён. Платные model API запрещены, CODEX_DISABLED в Windows Bridge не изменён.

## Текущая облачная машина

Поддерживаемый environment_status всё ещё сообщает spec_revision=2, без секретов и runtime variables; текущий egress — package manager presets. Домены Ollama/blob/OpenAI/ChatGPT и требования tunnel ID/runtime key сохранены в черновике, но к этой машине не применены.

Ранее реальная попытка подписочного Codex получила HTTP CONNECT403; это сетевой отказ, не доказательство истёкшей авторизации. Повторять вход или копировать auth файлы не требуется. Загрузка модели на этой облачной машине заблокирована blob-хранилищем; проверка реальных моделей перенесена на Linux GitHub runner.

Отдельный Codex CLI local-only E2E использует Ollama, а не подписочный OpenAI backend. Его результат надо проверять по конкретному CI run.

## Оставшиеся условия внешнего ChatGPT app

1. Настоящий Platform tunnel ID (полностью, с namespace при наличии).
2. Runtime principal с Tunnels Read + Use; ключ вводится только в защищённые настройки среды или локальный скрытый prompt.
3. Доступ среды к api.openai.com и разрешённый владельцем custom MCP app для того же tunnel в ChatGPT.

Создание/управление tunnel требует Read + Manage. Инструментов управления этими настройками аккаунта в данной сессии нет. Локальный dev proxy тестирует только транспорт клиента, не заменяет внешнюю регистрацию.

Порядок запуска: [MCP_TUNNEL_SETUP.md](MCP_TUNNEL_SETUP.md). Один совместный процесс UI/MCP: [UNIFIED_RUNTIME.md](UNIFIED_RUNTIME.md). Не запускайте второй независимый worker на той же БД.

Готовность внешнего канала подтверждается вызовом инструмента из пользовательского ChatGPT app и получением реального результата; публикация исходников сама этого не делает.
