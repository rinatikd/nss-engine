# Переносимые навыки

Обычные копии навыков находятся в `.agents/skills`; они не зависят от абсолютного пути профиля Windows и не являются ссылками на глобальную установку. Уже существующий `find-skills` сохранён. Источники и SHA256 нормализованного Git-текста SKILL.md (LF):

- `autocad-dwg-redraw` — pengxiaoan/autocad-dwg-redraw-skill; SHA256 `9870f816e369fa7be674b34ab03d7284a8d335c2ebdf75e8960e90d9825136fa`.
- `cad-automation` — delancy827/cad-skills; SHA256 `2414a5b7cab485163606be3ce4caf141708175f62ed2e9c92099ddef4c8c3f31`.
- `mcp-servers-for-revit-integration` — reason-machines/mcp-skills; SHA256 `286b3a6e9524a36b496215d3602bc41dd02f346b82502841c9e4dc43f38cd8a8`.
- `revit-element-collector` — Nice3point/revit-skills; SHA256 `9f9623f2cf3e07c4213a1a20232d5c63f9ab283e2786dee81049df7356cce7c9`.
- `revit-element-and-parameter-access` — Nice3point/revit-skills; SHA256 `ee646523ed6369046a146fd6639ccd01ef10f7c9cc11883927f44ca052b542f2`.
- `revit-external-events` — Nice3point/revit-skills; SHA256 `3437537f6662a379a8c750c99bd566e472df7d01cdc80a2ded82275e6546b20e`.
- `revit-multi-version-configuration` — Nice3point/revit-skills; SHA256 `20f04d1ed1a7f083b62be48baced97a8da1031d5d23d0f6ab31f23cac27ca59e`.
- `revit-sdk-project-configuration` — Nice3point/revit-skills; SHA256 `ed182a26958d195e907b478b2d2174790c0085c95456c68ea6438ef99c123707`.
- `revit-api-references` — Nice3point/revit-skills; SHA256 `2b70de3dd0ddeec5d5ea6efd44d7818a34daa43202db8ab8ce9820b013f2095d`.
- `graphify` — https://github.com/safishamsi/graphify; SHA256 `e1150326f0ed06db45e735ecb92b9d3048c9d165d61f61c5ecc728758a9c21f2`.

Файлы навыков сохраняют исходные уведомления и атрибуцию; условия распространения определяются upstream-репозиторием. Это набор инструкций и вспомогательных скриптов, не установленный MCP-сервер и не загруженный Revit/AutoCAD add-in. Подтверждённые версии на главном ПК: AutoCAD 2026 API net8 и Revit 2023 API net48. Не переносить примеры Revit 2025+ и NET10 в текущие add-in проекты без адаптации.

Локально сгенерированные `autocad-2026-local-api`, `revit-2023-local-api`, их provenance, установленные SDK/DLL и глобальные конфиги агентов намеренно не копируются. API-справочники при необходимости генерируются на целевом ПК из его установки Autodesk. Для нового рабочего места достаточно клона проекта для чтения переносимых навыков; исполняемый мост настраивается отдельно.

Правила этого проекта и указания пользователя имеют приоритет над общими инструкциями навыков: не закрывать пользовательские DWG, не запускать безусловный PURGE, не менять единицы существующего генплана и не стирать рабочие документы.
