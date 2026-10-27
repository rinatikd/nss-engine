# A2A — передача проекта, 27.10.2026

Это снимок исходников и незавершённой работы для другого аккаунта. Начать с SOURCE_INVENTORY.md, VALIDATION.md и LATEST_TESTS.txt. В repository находится полный опубликованный текстовый снимок NSS Engine вместе с A2A, UI, MCP, CLI и тестами. Манифест содержит SHA256 каждого файла, BUILD_INFO.txt — коммит.

Основные каталоги:

- repository/tools/ai-coordination-dispatcher-v0.23-reviewed — Python UI/MCP, общий runtime, рецензирование, launcher и клиент CLI-сервиса.
- repository/tools/a2a-js-v040-reviewed — HTTP/JSON-RPC, SQLite, local-only адаптер настоящего Codex, worker/service.
- repository/tools/handoff-wip/tunnel-cli-binding — незавершённая правка Tunnel launcher. НЕ подменять рабочие файлы без ревью и тестов. Помощник достиг лимита до окончательной проверки.
- repository/tools/handoff-input-sources — исходники предыдущих версий и Chrome SessionControl из исходного handoff. Файлы .json.in нужно восстановить в .json локально перед применением соответствующего пакета.

Нужны Python3.12+, зависимости requirements-interface.lock, Node22.13+. Внешних npm-зависимостей нет; .mjs запускаются напрямую. package.json.in — шаблон manifest для npm.

run_workspace.py связывает UI/MCP с JS ledger. Пример: python run_workspace.py --db /absolute/path/state.sqlite --codex-executable /absolute/path/codex --ui-port 18767 --mcp-port 18768 --transport streamable-http. Нужны официальный native Codex0.163 и локальная Qwen в Ollama. CLI включается явно, только Linux/local-only. Локальный RPC bearer генерируется в памяти. Сначала прочитать WORKSPACE_LAUNCHER.md.

Архив не содержит авторизации, cookies, API-ключей, runtime-бинарников, моделей и пользовательской SQLite. Эти данные через чат не переносить. Секреты и привязки между аккаунтами не переносятся. Live-процессы и пути старой /workspace не являются переносимым сервисом.

Платные API запрещены: бюджет0. Windows CODEX_DISABLED и production Bridge не менять. Настоящий ChatGPT app/Tunnel требует владельца аккаунта: tunnelID, runtimekey Read+Use и разрешённый app. Их нет в архиве; внешнее подключение не подтверждено.

INSTALL_CLOUD.sh и START_SKILL.md сохраняют несекретные инструкции настройки текущей облачной среды. Пути относятся к старой машине и требуют адаптации. Сетевые домены: api.openai.com, chatgpt.com, developers.openai.com, ollama.com, registry.ollama.ai и dd20bb891979d25aebc8bec07b2b3bbc.r2.cloudflarestorage.com. Требования: CONTROL_PLANE_TUNNEL_ID и защищённый A2A_TUNNEL_RUNTIME_KEY → CONTROL_PLANE_API_KEY (Tunnels Read+Use). Значения отсутствуют. Черновик настройки не доказывает применение сети или подключение app.
