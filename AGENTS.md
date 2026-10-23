## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.


## Основной ПК и GitHub

- Основной рабочий каталог: этот репозиторий `NSS_Engine`; remote `origin` — `https://github.com/rinatikd/nss-engine.git`. Главный ПК является источником текущего рабочего состояния. Не удалять локальные результаты/старые сборки ради чистого git status.
- Второй агент работает только в своей ветке `agent/<имя>/<задача>` или отдельном clone/worktree. Не переключать ветку под работающим владельцем главного ПК. Не push в main и не выполнять force push без явного отдельного указания.
- Перед новой веткой: проверить status, получить изменения origin, ответвиться от актуальной основной ветки. Не использовать reset --hard, clean -fd, переписывание истории или перенос пользовательских файлов для устранения конфликтов.
- Актуальные исходники и границы модулей описаны в README.md и docs/SOURCE_MAP.md. Старые дистрибутивы в output и work не считать актуальнее только по имени версии.
- Рабочие DWG/DXF/RVT/RFA, окружения, DLL/EXE, архивы, дампы, секреты и локальный graphify-out в репозиторий не добавлять. Не обходить .gitignore с git add -f. Дополнительные исходники добавлять после проверки состава и секретов.
- Переносимые навыки — только обычные файлы в .agents/skills. Не коммитить глобальные конфиги агентов, установленные API DLL или машинные API-справочники. Правила проекта и пользователя выше общих рекомендаций навыка.
- Перед коммитом: python tools/repo_guard.py --staged; перед публикацией: python tools/repo_guard.py --tree HEAD; автономные проверки: python tools/run_portable_checks.py. Это не заменяет нативную проверку в AutoCAD/Revit.
- Graphify: существующий локальный граф служит подсказкой, может быть устаревшим и включать дистрибутивные runtime. На чистом клоне граф отсутствует; начинай с карты исходников, не скачивай/не коммить дамп графа. Не публикуй вывод с секретами или исходной геометрией. Для обновления учитывай .gitignore и не сканируй окружения/результаты.
- Для .NET использовать framework реального хоста: текущий AutoCAD 2026 — net8.0-windows; локальный Revit 2023 — net48. Не грузить тестовую DLL в пользовательскую сессию автоматически, не менять SECURELOAD/TRUSTEDPATHS и не закрывать пользовательский AutoCAD.
