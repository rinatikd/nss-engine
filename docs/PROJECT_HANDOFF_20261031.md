# Передача NSS Engine / CCTV / AGPT / A2A / Chrome Bridge

Дата: 31.10.2026. Репозиторий https://github.com/rinatikd/nss-engine публичный. Компоненты развиваются в разных ветках; main не является объединением всех перечисленных кандидатов. Полные SHA ниже фиксируют проверенные исходники. Этот документ передаёт состояние, а не подтверждает финальную инженерную приёмку.

| Компонент | Ветка | Исходный SHA | Точка входа |
|---|---|---|---|
| NSS Engine / CCTV | agent/codex/nss-productization-20261030 | b84a140cf6e84568c19004dada94c24c85ab28c7 | docs/SOURCE_MAP.md; work/NSS_TKK_Editor_v0.2/modules/cctv/ |
| AGPT/APPT preview.14 | agent/codex/agpt-preview3-delivery-20261030 | 5964ee76bf4e388994f745f48158996fdcb8325d | tools/agpt-appt-preview3/README_RU.md |
| A2A | agent/codex/a2a-interface-mcp-v016 | ce43221bba68170d53e4e878b24337ce1eb451cc | tools/ai-coordination-dispatcher-v0.23-reviewed/; tools/a2a-js-v040-reviewed/ |
| Chrome Bridge RC2 | agent/codex/chrome-bridge-rc1 | 1282f09dab877fa4771b35150e77b07bd89a99be | tools/chrome-bridge-rc1/; docs/CHROME_BRIDGE_RC2_RELEASE_STATUS_20261030.md |

## Прямые ZIP исходников

Проверены без передачи пользовательского токена: HTTP200, ZIPCRC успешно. Это исходные Git-снимки, не ресурсно-полные установочные пакеты.

- NSS/CCTV: https://codeload.github.com/rinatikd/nss-engine/zip/b84a140cf6e84568c19004dada94c24c85ab28c7
- AGPT/APPT: https://codeload.github.com/rinatikd/nss-engine/zip/5964ee76bf4e388994f745f48158996fdcb8325d
- A2A: https://codeload.github.com/rinatikd/nss-engine/zip/ce43221bba68170d53e4e878b24337ce1eb451cc
- Chrome Bridge: https://codeload.github.com/rinatikd/nss-engine/zip/1282f09dab877fa4771b35150e77b07bd89a99be

## Состояние и ограничения

AGPT/APPT: 380 тестов ядра и6 тестов упаковки; успешный CI41197047751. Доступны выбор помещения мышью/контуром, запрос высоты, пользовательские настройки HFC-227ea/FH0.011м²/20°C, временное включение объектных привязок, список/подписи зон, встроенный запрос реквизитов ALBUM, графическая проекция сети, структура состава, спецификация и отдельная расчётная потребность. Известные названия Хладон227еа/HFC227ea нормализуются; другие вещества не подменяются. Методика и окончательное оформление требуют инженерной и нативной проверки. Клеммные связи не определяются из контура. Текущие исходники расположены в исторически названном tools/agpt-appt-preview3.

Реальные блоки/рамки/штампы присутствуют в отдельно собранном with-blocks архиве и на ПК владельца, но не в Git. В исходном комплекте нет шрифтов GOST/SHX. Source-only CI artifact не считать полной библиотекой. Последний пользовательский журнал preview.13 остановил ALBUM на неподдержанном имени ГОТВ зоны371B4A; raw GOTV в журнале не показан. Preview.14 исправляет известные варианты и выводит raw-значение при ошибке, но на этой зоне ещё не испытана. Отдельная старая автозагрузка NssEngine.dll с отсутствующего пути остаётся не исправленной; она не препятствовала последующей загрузке AGPT.

CCTV: свежие23 core и8 TKK integrity tests прошли. Thermal tests в проверенной среде заблокированы отсутствующим shapely; requirements-test.txt предусматривает shapely2.1.2. Реальные исходные DXF/JSON посёлка и результаты CCTV_v09 в облачных checkout отсутствуют. Исторические покрытия, количества и стоимости не считать пересчитанными. Для native-интеграции переносить целиком NSS_TKK_Editor_v0.2, не один CctvCommands.cs. Объектные run_*.py имеют старые абсолютные пути; finalize_package_v09.py переписывает другой сборщик, поэтому не запускать его только ради просмотра.

A2A: publicationce43221 новее fa24915. Реальное свидетельство локальной цепочки модели относится к прежнему f5dbeaa/run40616780857; оно не подтверждает hosted ChatGPT app/Tunnel или Windows isolation. Сохранять CODEX_DISABLED и нулевой бюджет платных API; секреты в чат не запрашивать. Состояние аккаунтов и модели Ollama в Git не переносятся.

Chrome Bridge: текущий1282f09 имеет portable check; предыдущие synthetic/native/real-sites результаты относятся к своим версиям. Токены браузера, пользовательские профили и состояние расширения не включены в передачу.

## Собранные полные архивы

CCTV_HANDOFF_20261031.zip:284622байта, SHA25621a15c4781d0a866ba7b38550780f424b7678d9380d1c26bf1347997a932b081. Код/каталог/тесты/native host и инструкция; частные входные DXF отсутствуют.

NSS_PROJECT_HANDOFF_20261031_AI.zip:33099739байт, SHA25693231d9ce881c991aba7b965c077f8fae9caad5d28f2e30f8c2d6a958d687f1b. Содержит шесть source snapshots, четыре AGPT DLL, семь CAD-файлов и семь PDF. Дубликаты исходников хранятся715объектами; RESTORE_SOURCES.py восстанавливает2475файлов. Архивы проверены, но их загрузка в GitHub Release пока не выполнена: uploads.github.com возвращает401 при работающей API-авторизации. Нельзя выдавать пустой draft release или workspace-ссылку за опубликованный полный архив.

## Промт для следующего агента

Продолжаем разработку по этому документу. Изучи AGENTS.md и SOURCE_MAP выбранного snapshot, проверь HEAD/status и используй нужную ветку с указанным SHA. Не объединяй ветки автоматически и не заменяй их main. Для AGPT начни с README_RU.md и REFERENCE_LAYOUT_RU.md, для CCTV — README/HANDOFF модуля и tools/cctv/README.md. Отделяй исходники, отсутствующие частные материалы и доказательства тестов; не выдавай кросссборку за запуск AutoCAD. Сохрани данные владельца, CODEX_DISABLED и бюджет платных API0. Уточняй только действительно недостающие исходные данные, затем продолжай запрошенную работу.
