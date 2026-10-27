# Проверка v0.16 — 27.10.2026 Asia/Qyzylorda

- PASS: 158 unittest, Python 3.12.14 / Linux.
- PASS: реальный MCP stdio subprocess: initialize, 7 tools, structured health,
  submit настоящей local-задачи, get, cancel, чтение состояния новым процессом.
- PASS: MCP Streamable HTTP: initialize, 7 tools, structured health.
- PASS: headless Chromium: demo task, automatic worker, answer, APPROVE, history,
  worker stop; mobile viewport 390x844 без горизонтального переполнения; page errors=0.
- PASS: desktop screenshot и mobile screenshot созданы вне репозитория для проверки.
- PASS: официальный Ollama v0.40.11 установлен после проверки SHA256 архива.
- PASS: Ollama HTTP version=0.40.11, cloud disabled, CPU-only setup.
- BLOCKED: registry blob download Forbidden; установленной модели пока нет.
- PASS: официальный tunnel-client full/runtime v0.0.18 после проверки SHA256.
- EXPECTED FAIL: tunnel-client doctor exit=2, missing tunnel ID.
- BLOCKED: CONTROL_PLANE_TUNNEL_ID и CONTROL_PLANE_API_KEY отсутствуют.
- UNVERIFIED: ChatGPT custom MCP app, actual model inference, AI semantic review.
- 0 платных model API вызовов. 0 model inference. 0 GitHub comment публикаций.

Исправление, найденное настоящим MCP-тестом: bare dict не создавал outputSchema
в SDK 1.29.0. Инструменты теперь явно возвращают dict[str, Any] с structured_output=True;
регрессионный тест проверяет structuredContent у настоящего MCP-клиента.

Ограничения проверки: Linux/Chromium, Windows .cmd и аккаунт ChatGPT не тестировались.
Нет стандартного A2A wire protocol или Windows coding runner. Не финальная версия.
