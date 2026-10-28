# ChatGPT Secure MCP Tunnel — общий UI/MCP и опциональный Codex

Используйте официальный tunnel-client 0.0.18 и проверенный Python 3.12+ environment. tunnel_connector.py создаёт фиксированный stdio-профиль; tunnel_mcp_entry.py запускает run_workspace.py. Один общий процесс владеет UI и MCP. Не запускайте дополнительно web_app.py или mcp_bridge.py на той же SQLite.

По умолчанию локальный Codex backend выключен. Его инструменты видны в MCP-каталоге, но health возвращает NOT_CONFIGURED. Для включения backend нужно явно привязать проверенный native Codex 0.163 через --codex-executable. Этот вариант проверен только на Linux, использует только локальный Ollama/Qwen и не снимает Windows CODEX_DISABLED.

## Условия внешнего подключения

В целевой Platform организации должен существовать настоящий tunnelID, связанный с нужной рабочей областью ChatGPT. Runtime key требует Tunnels Read+Use; создание/изменение туннеля требует отдельно Manage. Launcher не создаёт туннели и не использует admin key.

Ссылки из официального клиента0.0.18:

- https://platform.openai.com/settings/organization/tunnels
- https://platform.openai.com/settings/organization/api-keys
- https://chatgpt.com/#settings/Connectors

Владелец аккаунта должен разрешить private custom MCP app для того же tunnel. Ключ вводится только в защищённые настройки среды либо локальный скрытый prompt, не в чат. Публикация исходников и локальный devproxy не регистрируют приложение ChatGPT.

## Подготовка профиля

Все пути абсолютные. Каталог профилей должен быть вне исходников, в приватном runtime-каталоге. CONTROL_PLANE_TUNNEL_ID — полный настоящий идентификатор: tunnel_<32 lowercase letters/digits> или tunnel_<4 lowercase letters/digits>_<32 lowercase letters/digits>. Проверка синтаксиса не доказывает принадлежность ID аккаунту.

Пример Linux, без Codex backend:

```bash
export CONTROL_PLANE_TUNNEL_ID='REPLACE_WITH_REAL_PLATFORM_TUNNEL_ID'
python tunnel_connector.py prepare \
  --client /absolute/path/tunnel-client \
  --db /absolute/path/state.sqlite \
  --profile-dir /absolute/private/path/tunnel-profile
```

Значение REPLACE... намеренно не проходит проверку. Замените его локально настоящим ID. Не придумывайте ID для hosted запуска.

Чтобы явно включить локальный Codex, добавьте одинаковые параметры во все prepare/check/doctor/run команды:

```bash
--codex-executable /absolute/path/to/verified/native/codex \
--codex-model qwen2.5:3b
```

Разрешены модели qwen2.5:3b и qwen2.5:7b. Нужны Node 22.13+, соседний каталог a2a-js-v040-reviewed и локально установленная модель в Ollama. ELF/путь/версия — проверки конфигурации, не доказательство издателя бинарника; оператор должен заранее проверить официальный архив и его checksum. Windows wrappers, symlinks и произвольные дополнительные CLI-параметры этим режимом не принимаются.

Launcher генерирует JSON-as-YAML с фиксированным sibling entrypoint, env:CONTROL_PLANE_API_KEY и ephemeral loopback health/admin listener. Ключа в файле нет. Создание эксклюзивное: существующий профиль не перезаписывается. Изменение Python/source/db/UIport/tunnelID/Codex executable/model требует осознанного пересоздания профиля; check отвергает отличие от ожидаемого полного содержимого.

## Проверка и запуск

С теми же путями и, если выбраны, Codex-параметрами:

```bash
python tunnel_connector.py check --client /absolute/path/tunnel-client --db /absolute/path/state.sqlite --profile-dir /absolute/private/path/tunnel-profile
python tunnel_connector.py doctor --client /absolute/path/tunnel-client --db /absolute/path/state.sqlite --profile-dir /absolute/private/path/tunnel-profile --prompt-key
python tunnel_connector.py run --client /absolute/path/tunnel-client --db /absolute/path/state.sqlite --profile-dir /absolute/private/path/tunnel-profile --prompt-key
```

Если защищённая среда уже передаёт CONTROL_PLANE_API_KEY, --prompt-key не нужен. Иначе doctor и run независимо запрашивают ключ скрыто в интерактивном терминале. Значение передаётся только через child environment; не сохраняется в файле/argv/отчёте. Неинтерактивный fallback запрещён.

check выполняет только локальную проверку профиля/версии/наличия ключа. LOCAL_PREREQUISITES_READY не доказывает авторизацию, сетевой доступ или ChatGPT discovery. doctor запускает явную официальную диагностику с timeout 45s и не публикует её сырой вывод. run работает foreground, Ctrl+C останавливает owned runtime. Сам launcher модельную задачу не отправляет.

UI слушает loopback 8765 по умолчанию; --ui-port можно одинаково изменить во всех командах. Не запускайте второго владельца на том же порту/БД. Local Codex service, если включён, получает собственный loopback port и случайный bearer в памяти. Недоступный Ollama оставляет его очередь невыполненной; liveness не является доказательством реальной inference.

Ambient CONTROL_PLANE/MCP/Harpoon/remoteUI/logging overrides удаляются перед стартом tunnel-client. HTTPS proxy и CA trust сохраняются. Перед exec workspace удаляются tunnel/OpenAI keys и A2A_CODEX_RPC_URL/TOKEN: профиль без явного CLI-флага не может случайно подключиться к чужому ранее настроенному backend. Явный CLI launcher генерирует собственную новую RPC привязку. Это ограничение конфигурации и наследования ключей, не доказательство процессной изоляции.

## Проверка из ChatGPT

Каталог содержит 13 инструментов: 9 dispatcher/review/diagnostics и 4 Codex health/submit/get/cancel. MCP намеренно не перечисляет все задачи и не запускает произвольные процессы.

Для локального Ollama review-loop используйте dispatcher_health, dispatcher_start_local_worker, dispatcher_submit_task и dispatcher_get_task. Для подготовленного Codex service — dispatcher_codex_health, dispatcher_codex_submit_task и dispatcher_codex_get_task. Передавайте новый request_id из 32 hex-символов; сохраняйте и повторяйте тот же ID и payload при неопределённом ответе. Изменённый payload под тем же ID вызывает конфликт. В статусах нет исходного prompt/rubric/worker request. CLI completed не означает AI review, человеческое принятие или публикацию.

Только submit/status обмен, инициированный настоящим ChatGPT custom app через работающий hosted daemon, подтверждает внешнее подключение. Doctor, daemon health, SDK или devproxy сами по себе этого не подтверждают. Confirmation policy write-инструментов настраивается в аккаунте ChatGPT отдельно.

## Проверенные результаты 28.10.2026

- 16 offline launcher tests PASS; два регрессионных теста сначала воспроизвели утечку ambient RPC binding и затем прошли после исправления.
- Настоящий официальный tunnel-client 0.0.18 devproxy → stdio run_workspace → MCP: 13 инструментов, health/submit/get/cancel PASS без ключей и модельных вызовов.
- Тот же транспорт проверен с явной привязкой настоящего native Codex 0.163. Backend configured/available/authenticated; без неё configured=false даже при ambient RPC переменных. Health не объявляет execution_ready или Windows готовыми. CLI запускался только для version/startup, реальной модели в этих двух тестах не было.
- Оба локальных control-plane fixtures очищены, hosted_tunnel_verified=false и chatgpt_app_verified=false. Hosted/admin API-запросов 0; модельных и платных вызовов 0.

Команда базового локального transport check:

```bash
python verify_local_tunnel.py --client /absolute/path/tunnel-client --timeout 40
```

Это bounded dev fixture с локальным control plane, не способ обходить отсутствующие hosted права или настройки аккаунта.
