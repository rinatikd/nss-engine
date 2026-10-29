# Chrome Bridge: локальная приёмка Claude

Дата: 29.10.2026, Asia/Qyzylorda.

Версия: `0.2.1-rc.1`. Проверяемая база исходников:
`dd5dd0fb2bd494b9c6275dc969fdc533c3248761`.
На ПК оператора адрес сервера и разрешение расширения согласованно настроены
на отдельный loopback-порт 17383. Работающие установки на других портах
не останавливались.

## Источники свидетельств

- **CI_VERIFIED:** [автоматическая приёмка 40745209801](https://github.com/rinatikd/nss-engine/actions/runs/40745209801)
  завершилась успешно: Windows/Ubuntu с Node 22/24, PowerShell setup/doctor/preview,
  синтаксис PowerShell и синтетический MV3 E2E в настоящем Chromium.
  Страницы Claude/Gemini/DeepSeek в этом E2E являются локальными макетами.
- **OPERATOR_REPORTED_LIVE_WINDOWS:** оператор предоставил результаты команд,
  выполненных на своём ПК, и подтвердил состояние интерфейса расширения.
  Этот отчёт фиксирует предоставленные результаты; облачный агент не выполнял
  команды непосредственно на ПК оператора.

## Результаты на ПК оператора

| Проверка | Предоставленный результат |
|---|---|
| MCP и Chrome | `passed`, `authenticatedMcp`, `requiredToolsPresent`, `chromeConnected`, `readableStateVerified` — true |
| Свежий запрос в тестовую беседу Claude | `functionalAgentObserved=true`, `nonceObserved=true`, `failureCode=null` |
| Повтор того же requestId | `sent=false`, `duplicate=true`, `requestIdMatches=true`, `replyCountUnchanged=true` |
| Stop | `chromeConnected=false`, `sendRejected=true`, `journalEntryCreated=false` |
| Подключение после перезапуска | оператор подтвердил подключение и отсутствие автоматически восстановленного Control |
| Повтор старого запроса после перезапуска | `journalPreserved=true`, `duplicate=true`, `sent=false`, `originalReplyRecovered=true`, `replyCountUnchanged=true` |
| Codex CLI MCP | оператор сообщил Codex CLI 0.165.0, отдельная stdio-регистрация включена, `chrome-bridge-rc1: connected (18 tools)`; вход через ChatGPT |
| Запрос из настоящего Codex CLI | выбранный Free-аккаунт, запуск без общего daemon; один `agent_ask`, `done=true`, проверочный код обнаружен, `UNKNOWN/UNVERIFIED` сохранены |
| Новый запрос после повторной выдачи Control | новый отличный requestId, `passed=true`, `functionalAgentObserved=true`, `nonceObserved=true`, `failureCode=null` |

Для проверенного локального сценария Codex CLI → MCP → Chrome Bridge →
веб-беседа Claude → ответ функциональная приёмка по отчётам оператора пройдена.
В результате успешного нового `agent_ask` поле `duplicate` не возвращалось;
оно не было выдано за `false`. Дополнительная отправка
для повторения уже успешных проверок не требуется.

## Границы результата

`deliveryStatus=UNKNOWN` и `replyAttribution=UNVERIFIED` сохранены. Наблюдение
кода в ответе подтверждает функциональное поведение браузерного канала,
но не даёт строгой аттестации модели или криптографической атрибуции ответа.

Следующие возможности этим результатом не подтверждены:

- регистрация и работа в Claude Code;
- подключение custom MCP app к этой беседе ChatGPT;
- обмен с реальными аккаунтами Gemini и DeepSeek;
- изолированное выполнение заданий Codex через Bridge: `CODEX_DISABLED` сохранён.

Следующий этап — контролируемое обновление до RC2 с сохранением рабочего порта,
pin расширения, отдельного каталога состояния и журнала. На момент этих
live-проверок на ПК оператора установлена RC1. Проверка авторизации сообщила
`CHATGPT_LOGIN`; нужный аккаунт подтвердился после запуска `--no-daemon`.
Секреты, тексты бесед,
личные пути, идентификаторы вкладок и данные авторизации в отчёт не включены.
