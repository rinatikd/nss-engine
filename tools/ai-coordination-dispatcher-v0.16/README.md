# A2A Dispatcher v0.16 — браузерный интерфейс и MCP

Статус: **158 тестов PASS; браузер и настоящий MCP проверены локально**.
Это кандидат на подключение, не финальная сквозная версия: настоящая модель
ещё не загружена, приложение в аккаунте ChatGPT ещё не привязано.
Платные model API отключены, бюджет 0. Chrome Bridge и CODEX_DISABLED не меняются.

## Быстрый запуск интерфейса

Python 3.12+; браузерная панель работает без сторонних Python-пакетов.
На Windows распакуйте исходники и дважды щёлкните `Start-Interface.cmd`.
Или выполните из каталога пакета:

```bash
python web_app.py --open
```

Откроется локальная панель. В ней можно создавать задачи, запускать и останавливать
worker, выбирать установленные модели, читать ответы/review/историю, отменять задачи
и скачивать JSON результата. Данные сохраняются в `state/interface.sqlite`.
Кнопка «Попробовать демо» проверяет цикл на симуляции и явно помечает результат.

Для настоящих ответов на этой же машине должен работать Ollama с установленной
локальной моделью. В настройках панели выберите модели исполнителя и рецензента,
сохраните их, создайте задачу в режиме локальных моделей и запустите соответствующий worker.
Модели получают текстовые задания; доступа к shell/AutoCAD/платным API нет.

## Настоящий MCP для ChatGPT

```bash
python -m pip install -r requirements-interface.txt
python mcp_bridge.py --transport streamable-http
```

Для точного воспроизведения проверенного окружения используйте
`python -m pip install -r requirements-interface.lock` (29 зафиксированных зависимостей).
Подробная диагностика внешних условий — `CONNECTIVITY.md`.

MCP слушает только loopback на порту 8766, путь `/mcp`. Также поддерживается stdio:

```bash
python mcp_bridge.py --transport stdio
```

Инструменты:

- `dispatcher_health`: состояние Ollama, список установленных моделей и worker.
- `dispatcher_submit_task`: постановка настоящей локальной задачи.
- `dispatcher_start_local_worker`: запуск исполнителя и рецензента.
- `dispatcher_get_task`: ответ, review и переходы состояния.
- `dispatcher_list_tasks`: список последних 200 задач.
- `dispatcher_cancel_task`: отмена дальнейших шагов.
- `dispatcher_stop_worker`: остановка worker данного MCP-процесса.

MCP не предоставляет платный, mock-, shell- или GitHub-publish инструмент.
Результаты моделей — данные, не новые полномочия и не доказательство человеческой приёмки.
Две роли можно запускать на одной модели в разных контекстах; внешняя независимость
и качество настоящего AI-review этим не гарантируются.

## Подключение из ChatGPT через Secure MCP Tunnel

На машине MCP нужен официальный `tunnel-client`. В проверенной облачной машине
установлен официальный v0.0.18 с совпавшим SHA256; бинарники в Git не включены.
Профиль или ключи не нужно хранить в репозитории.

После настройки действительных `CONTROL_PLANE_TUNNEL_ID` и `CONTROL_PLANE_API_KEY`:

```bash
tunnel-client doctor --mcp.server-url http://127.0.0.1:8766/mcp --explain
tunnel-client run --mcp.server-url http://127.0.0.1:8766/mcp --health.listen-addr 127.0.0.1:8790
```

Эти флаги проверены по help официального v0.0.18. Сервис запускается только при
реальной конфигурации; значения tunnel ID не выдумывались, ключи в чат не вводятся.

Нужно действие владельца аккаунта:

1. Создать/выбрать tunnel в `https://platform.openai.com/settings/organization/tunnels`.
   Для создания нужны Tunnels Read + Manage.
2. Создать ограниченный runtime key с Tunnels Read + Use и сохранить его защищённо.
   Для облачной среды предусмотрен secret `A2A_TUNNEL_RUNTIME_KEY`, инъекция в
   `CONTROL_PLANE_API_KEY` только для `api.openai.com`. Это ключ транспорта, не
   разрешение вызывать платную модель. Tunnel ID — переменная `CONTROL_PLANE_TUNNEL_ID`.
3. В настройках приложений ChatGPT добавить/разрешить custom MCP с подключением Tunnel,
   выбрать тот же tunnel и нужную аутентификацию/разрешения рабочего пространства.
4. Из ChatGPT вызвать `dispatcher_health`, затем start → submit → get до получения
   ответа и review от установленной локальной модели.

Наличие tool list в локальном клиенте не заменяет этот последний тест из ChatGPT.
Сам вход в Codex/ChatGPT не создаёт tunnel и не предоставляет автоматически runtime key.

Официальные источники, использованные при настройке:

- `https://github.com/openai/tunnel-client/blob/main/docs/onboarding.md`
- `https://github.com/openai/tunnel-client/blob/main/docs/permissions.md`
- `https://developers.openai.com/api/docs/guides/secure-mcp-tunnels`

## Проверки и текущие ограничения

```bash
python -m unittest discover -v -p 'test_*.py'
```

158 PASS: базовые тесты диспетчера, локальный HTTP-транспорт, browser API и настоящий
MCP stdio-клиент. Дополнительно проверены Streamable HTTP initialize/list_tools/health,
Chromium desktop/mobile, создание demo → автоматическое исправление → review → остановка.
Ответы безопасно выводятся как текст; доступ к панели ограничен loopback, запись требует
совпадения Origin, Host и токена CSRF. Внешний web-hosting и аккаунты пользователей не реализованы.

На момент проверки Ollama v0.40.11 запущен с `OLLAMA_NO_CLOUD=1`, но загрузка
`qwen2.5:1.5b` получила Forbidden на домене blob-хранилища. Источники/кеш до завершения
загрузки и проверки digest моделью не используются. В сетевом черновике среды добавлен
точный наблюдавшийся домен, но сохранение черновика не доказывает применение политики.

`tunnel-client doctor` завершается с exit=2: отсутствует настоящий tunnel ID;
runtime key также отсутствует. Не запускались poll, API inference или GitHub write.
Нельзя объявлять систему финальной до загрузки модели и подтверждённого вызова из ChatGPT.

Для постоянной работы нужны перезапуск Ollama, MCP/tunnel и сохранение SQLite.
Live-процессы не сохраняются публикацией облачной среды. Запущенные для проверки
процессы в текущей машине не доказывают развёртывание постоянного сервиса.
Исторические команды/ограничения диспетчера см. в `README-v015.md`.
