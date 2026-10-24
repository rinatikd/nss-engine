# Совместная работа NSS Engine

Сначала прочитай [AGENTS.md](AGENTS.md), [карту исходников](docs/SOURCE_MAP.md), [переносимые навыки](docs/PORTABLE_SKILLS.md) и [процесс совместной работы](docs/AGENT_COLLABORATION.md). Эти правила применяются и к Claude; инструкции для Codex не являются разрешением игнорировать границы проекта.

Возможности Claude зависят от текущей сессии, подключённых инструментов и прав; перед поручением операции проверяй эти возможности. GitHub integration сам по себе не подтверждает запуск кода, Git push или создание PR. Не обещай операции, которые текущая сессия не умеет выполнить. Не включай платный API/подписку. Для анализа выбирай нужные файлы и конкретную ветку, указывай SHA, если он доступен. Результаты передавай в формате docs/CLAUDE_HANDOFF_TEMPLATE.md. Не выдавай предложенный патч за применённый или проверенный.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.
For this repository, read `AGENTS.md` and `docs/GITHUB_AGENT_WORKFLOW.md` before changing files. Work from the assigned issue in a separate branch (use `agent/claude/<issue>-<slug>` if the host allows a custom name) and return a pull request. Never push to `main`; follow the project's private drawing, secret, and Autodesk boundaries.
