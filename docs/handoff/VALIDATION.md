# Что действительно проверено

- Настоящие executorQwen3B/reviewerQwen7B через MCP: PASS, GitHub run40517940935.
- Общий UI+MCP runtime с моделями: PASS, run40520744532, commit6e55bfe. Верный расчёт8Мбит/с и86.4десятичныхГБ; APPROVE с необязательной рекомендацией принят.
- Настоящий Codex CLI0.163 → OllamaQwen3B → HTTP/JSONRPC/SQLite: PASS, run40521441115, commitfa24915. Ответ A2A_CODEX_LOCAL_E2E_OK,11outputtokens, tools=[], платных API-вызовов0.
- Настоящий tunnel-client0.0.18 devproxy → stdioMCP: PASS локально. Повторно проверено на текущем снимке:13инструментов, создание/чтение/отмена задачи; hostedTunnel=false, ChatGPTapp=false.
- Полный новый MCP→JS→настоящийCodex→Ollama: PASS, run40564442342, commit37de6a5,50s. mcp_verified=true, один taskID при повторе, ответ A2A_CODEX_LOCAL_E2E_OK,11outputtokens, tools=[], платных API-вызовов0.
- До последней CLI-панели:220Python +42JS +3UI PASS.
- Последние service/abort изменения:46JS PASS. Новая UI-панель:8Node PASS; клиент/MCP:14targettests PASS; launcher:3Python PASS. Итог полного текущего прогона — в LATEST_TESTS.txt.

НЕ ПОДТВЕРЖДЕНО на момент handoff: новая Tunnel→run_workspace опция остаётся WIP; реальный ChatGPT app; подписочный OpenAI backend; Windows filesystem/network isolation и executiongate.

Последняя ошибка общего Python прогона: устаревшее ожидание9MCP-инструментов в HTTP-тесте вместо13. Ожидание расширено четырьмя добавленными именами; проверки не удалены. Повторный итог см. LATEST_TESTS.txt.

Не выдавать fakeCLI, sessionID, HTTPhealth, импорт профиля или локальный devproxy за реальный вызов модели/ChatGPT. CI Success и observed-result annotations проверены через GitHub; полные артефакты в этой сессии не скачивались.
