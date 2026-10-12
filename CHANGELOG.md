# Changelog

## v0.3.0
- Long-term memory that lasts across sessions:
  - The Cloudflare Clef-flash classifier decides what is worth remembering and what to recall.
  - Facts are embedded with bge-m3 and stored locally, with optional D1 sync through the gateway.
  - New `memory_save`, `memory_search` and `memory_forget` tools, the `/memory` command and `atom memory`.
- Keyless `web_search` tool (DuckDuckGo, falling back to Bing RSS) and `atom search`.
- MCP now works over Streamable HTTP and legacy SSE as well as stdio, including resources. Add servers with `atom mcp add NAME --url …`.
- Plugins: local or npm ES modules can register tools, slash commands and event hooks (user_prompt, pre_tool, post_tool, turn_end, session_start), and can bundle skills and commands. Install with `atom plugin install`.
- Skills: SKILL.md folders are discovered in .atom and .agents dirs and from plugins. The model invokes them through the `skill` tool, and you can run them as `/<skill>`.
- Repo index: `atom index` and the `semantic_search` tool. Chunks are embedded with bge-m3, the index respects .gitignore, and re-indexing is incremental by content hash.
- New `repo_map` tool.
- @-mentions now cover folders, globs, line ranges (`@file:10-40`), symbols (`@#name`) and images, with size caps.
- Named projects (`atom project add|list|switch|show|remove`, `atom -P`), each with its own instructions, knowledge files, settings, memory scope and sessions.
- Custom subagents defined in `.atom/agents/*.md` and run through the task tool.
- `atom update` and `atom update --check`. Atom also checks for updates in the background once a day, shows the result in the footer, and installs automatically when `autoUpdate: true` is set. Set `ATOM_DISABLE_AUTOUPDATE` to opt out.

## v0.2.0
- Full-screen differential TUI with Shift+Tab mode cycling, slash and @ autocomplete, task subagents, a session tree, auto-compact, AGENTS.md support and image input.

## v0.1.0
- First release: a Workers AI terminal coding agent with permissions, plan mode, `-p`, `/init`, `/rewind`, resume, hooks and MCP over stdio.
