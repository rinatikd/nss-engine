# Staging diagnostics profile

This profile permits only four reviewed configuration keys. It contains no MCP server, plugin, app connector, hook, credential, or custom tool entry. Codex built-ins, managed/system/project policy, environment inheritance, and the actual Windows sandbox are outside this TOML file and remain **UNVERIFIED**. Using this profile for `--version`, `features list`, and `mcp list` is read-only diagnostics only and never authorizes model/tool execution. Do not copy or modify the user's config to create this profile.
