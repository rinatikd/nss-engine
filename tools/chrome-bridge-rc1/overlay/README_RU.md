# Chrome Bridge 0.2.1-rc.2

Актуальная установка и границы проверки: [RELEASE_CANDIDATE_RU.md](RELEASE_CANDIDATE_RU.md). Далее сохранена историческая документация 0.2.0; при расхождениях используйте новую инструкцию.

# Chrome Bridge 0.2.0 — Agent Hub

Мост между локальными ИИ-агентами (Codex CLI, Claude Code и др.) и вашим Chrome плюс слой **Hub** для совместной работы нескольких ИИ над проектом через их веб-интерфейсы: ведущий агент пишет концепцию и план, раздаёт задания, ведёт ревью и дебаты, гоняет пачки однотипных заданий и собирает релиз.

Зависимостей npm нет, нужен Node.js 22+. Windows + Chrome 120+.

## Архитектура

```
Ведущий ИИ (Codex / Claude Code) ──MCP stdio──► server/stdio.mjs ─► HTTP 127.0.0.1:17381
          │  инструменты browser_* и agent_*                          │ long-poll
          │  + файлы проекта + hub/hub.mjs (CLI)                      ▼
          ▼                                         Расширение Chrome (вкладка управления)
   Каталог проекта                                   ├─ вкладка ChatGPT   (агент «gpt»)
   PROJECT / PLAN / tasks / runs / accepted / release├─ вкладка Gemini    (агент «gemini»)
                                                     └─ вкладка Claude    (агент «claude1»)
```

Три слоя:
1. **Мост** (`server/`, `extension/`) — безопасный доступ к вкладкам только разрешённых сайтов.
2. **Агентские чаты** (`agent_*`) — «отправить сообщение в чат и дождаться ответа» через настраиваемые адаптеры селекторов.
3. **Hub** (`hub/`) — протокол проекта: задания, цикл «исполнитель → рецензент → доработка», пакеты, отчёт, релиз.

Плейбук ведущего агента: **ORCHESTRATOR.md**.

## Установка

1. Распакуйте архив, например в `C:\Engineering\chrome-bridge`.
2. `powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-Windows.ps1` — создаст ключи в `%USERPROFILE%\.chrome-bridge\config.json` и покажет ключ браузера. Не отправляйте ключи в чаты.
3. В отдельном окне PowerShell: `...\Start-Bridge.ps1`, оставьте открытым.
4. Chrome → `chrome://extensions` → режим разработчика → «Загрузить распакованное расширение» → папка `extension`. Если обновляете с 0.1.0, нажмите «Обновить» у расширения.
5. Значок расширения → вкладка управления: вставьте ключ браузера, **Подключить**.
6. `...\Connect-Agents.ps1` — зарегистрирует мост в Codex и/или Claude Code. Запустите новую сессию агента.

## Сайты и режимы

В вкладке управления → «Сайты» (только HTTPS, поддомены отдельно):
- **Обычный сайт (чтение)** — `browser_tabs/open/read/wait`; клики и ввод — только если включён переключатель и каждое действие подтверждено кнопкой в окне.
- **ИИ-чат** — дополнительно `agent_*`: ввод текста в поле чата и нажатие «Отправить» без подтверждения каждого сообщения. Это осознанное решение пользователя для конкретного сайта. Сообщения уходят стороннему сервису.

## Привязка агентов

1. Откройте чаты в **отдельном окне Chrome** (не сворачивайте его; отключите «Экономию памяти» для этих сайтов — иначе фоновые вкладки могут «засыпать»). Войдите в аккаунты.
2. `agent_list` (или `node hub\hub.mjs agents`) покажет вкладки; `agent_bind {name:"gpt", tabId:123}` (или `hub bind gpt 123`).
3. `agent_selftest {name}` — сколько элементов находит каждый селектор.
4. **Адаптеры не проверены на живых сайтах.** Встроенные селекторы ChatGPT/Claude/Gemini — предположения; вёрстка меняется. Калибруйте через selftest и поле «Адаптеры (JSON)» в окне расширения. Для другого сайта используйте адаптер `generic` с вашими селекторами.

## Инструменты MCP

| Инструмент | Назначение |
|---|---|
| `browser_status`, `browser_tabs`, `browser_open`, `browser_read`, `browser_wait` | чтение разрешённых сайтов (секреты в выводе скрываются) |
| `browser_click`, `browser_fill` | действия, каждое подтверждается кнопкой в окне; показывается элемент, ссылка/форма |
| `agent_list`, `agent_bind`, `agent_new_chat`, `agent_selftest` | управление агентами |
| `agent_send` → `agent_wait` / `agent_ask` / `agent_peek` | диалог с агентом; ответ готов, когда исчез «Стоп» и текст перестал меняться |

`agent_wait` ждёт ≤ 55 с и возвращает `done:false`, если ответ ещё идёт; вызывайте повторно (Hub делает это сам до 15 минут).

## Hub: проект

```
node hub\hub.mjs init C:\Projects\demo       # каркас
cd C:\Projects\demo
node C:\...\hub\hub.mjs status | agents | run T001 | batch batches\B001.json | report | release --name v1
```
Структура проекта: `PROJECT.md` (концепция), `PLAN.md`, `rubric.md`, `agents.json` (роли, лимиты), `tasks/Txxx.json`, `runs/Txxx/round-N.{reply,review}.md`, `accepted/`, `release/NAME/` (+`MANIFEST.json`, `REPORT.md`), `LOG.jsonl`.

Цикл задачи: исполнитель отвечает → рецензент (другой агент) возвращает JSON `{score, verdict, must_fix, suggestions}` → при `revise` замечания уходят исполнителю в тот же чат → до принятия (`score ≥ pass_score`, пустой `must_fix`) или `max_rounds`. Неразобранный вердикт переспрашивается один раз, затем задача получает `needs_orchestrator`. `--resume` продолжает прерванный запуск.

`batch`: шаблон задания с `{{переменными}}` + список `items`; параллелизм — по числу независимых пар агентов (привяжите несколько вкладок одного сайта под разными именами).

Файловый вывод: для задач с `"output_files": true` агенты оформляют файлы блоками `=== FILE: путь === … === END FILE ===`; `release` раскладывает их по путям (абсолютные пути и `..` отклоняются, коллизии — ошибка).

## Что изменилось с 0.1.0

- Long-poll вместо таймера раз в секунду — фоновая вкладка больше не «отваливается» из-за троттлинга; удержание Web Lock.
- Очередь подтверждений в окне (кнопки Разрешить/Отклонить, мигание заголовка, звук) вместо `window.confirm`; показывается тип, текст, ссылка и форма элемента; элемент перепроверяется перед действием.
- Опциональное подтверждение чтения; редактирование очевидных секретов в выводе `browser_read`; запрет отправки секретов в чаты.
- Только HTTPS; `browser_wait`; чтение по селектору; `browser_open` по умолчанию во фоне.
- Исправлены лимит тела запроса (закрывает соединение), сборка тела по байтам, согласование версии MCP, остановка `stdio.mjs` по закрытию stdin.

## Проверки

- `node --test tests/*.test.mjs` — мост и разбор вердиктов/файлов.
- `xvfb-run -a node tests/e2e.mjs` (нужен playwright) — настоящий Chromium с расширением против имитации двух чат-сайтов: подключение, `agent_ask`, одобрения, цикл ревью в 2 раунда, batch, release, переспрос вердикта, остановка.
- Не проверено: живые ChatGPT/Gemini/Claude (селекторы, капчи, ограничения), PowerShell на Windows.

## Ограничения и ответственность

- Автоматизация веб-интерфейсов сторонних сервисов может противоречить их условиям использования и привести к ограничениям аккаунта. Проверьте условия каждого сервиса; где есть официальный API, надёжнее и допустимее он. Hub соблюдает паузы и часовые лимиты (`agents.json`), не обходит капчи и авторизацию.
- Один мост — один браузер; команды выполняются последовательно (быстрые, ожидание ответа — в мосте). Вкладка управления должна быть открыта.
- Не реализованы: скриншоты, iframe, PDF, скачивание, произвольный JS, вложения в чаты.
- Подключение веб-ChatGPT/облачных клиентов: нужен защищённый HTTPS-туннель, публикующий только `/mcp` с проверкой ключа агента; `/bridge/*` публиковать нельзя.
- Остановка: «Остановить» в окне, Ctrl+C в окне моста; «Отозвать все сайты» снимает разрешения. Удаление: `codex mcp remove chrome-bridge`, `claude mcp remove chrome-bridge`.

Local Codex CLI integration and connector registration: see [integration-reports/codex-connector.md](integration-reports/codex-connector.md). The three `codex_*` tools require an operator-owned isolated runner; execution is disabled by default. Existing browser agents are unchanged.

Three-origin control and safe activation: see [CONTROL_PERMISSIONS.md](CONTROL_PERMISSIONS.md). Control requires explicit local approval for claude.ai, gemini.google.com or chat.deepseek.com and explicit re-grant after expiry, origin change or restart; other origins remain read-only. This policy supersedes older unrestricted chat/action instructions above.
