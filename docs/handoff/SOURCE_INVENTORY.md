# Состав снимка

Включены: полный текстовый Git tree ветки NSS Engine; Python A2A v0.15/v0.16 и reviewedv0.23; JS reviewedv0.4; исходники HTTP/JSON-RPC, SQLite, MCP, UI, Codexlocal adapter, launcher; тесты/workflows; текстовые компоненты исходного handoff; отдельно помеченная последняя WIP-правка Tunnel.

Не включены: .git, окружения, EXE/библиотеки, веса моделей, логины ChatGPT/Claude, ключи, cookies, настоящая рабочая SQLite, приватные логи. Полный Windows Chrome Bridge не был предоставлен исходниками: имеется SessionControl patch, а не весь сервер. Внешний PR51 Windows Broker не выдаётся за включённый/проверенный.

Корневой BUNDLE_SHA256SUMS.txt содержит хеш каждого файла. BUILD_INFO.txt содержит коммит; локальная сборка до коммита явно помечается working tree. Рабочие данные другой машины восстанавливаются отдельно безопасным способом.
