# Changelog

## v0.5.1 (security)
- Workspace trust: hooks, MCP servers, allow rules, plugins and permission mode from a project's `.atom/` only apply after
  `atom trust` (or `ATOM_TRUST_PROJECT=1`). Opening a cloned repository can no longer run its commands.
- `bypass` permission mode can only be enabled from the command line, never from a settings file.
- `bash:prefix *` allow rules no longer match commands containing shell control characters (`;`, `&&`, `|`, `$()`, backticks, redirects, newlines).
- Read-only tools ask before reading outside the project directory; `web_search` asks when the query contains a long token-like string.
- Atom Cloud: session cookie is encrypted (AES-GCM), constant-time secret comparisons, SSRF guard on the agent's `web_fetch`, security headers.
- Gateway: constant-time key comparison; `/health` reports whether the key is long enough; `atom login --gateway` warns on short keys and requires https.

## v0.5.0
- One backend for the terminal and the web: Atom Cloud sessions can be started, continued, diffed and turned into PRs from
  the CLI, the Atom Cloud web UI, or a web assistant that proxies the same API (for example a harness "Code" tab).
- `atom cloud new OWNER/REPO [--branch B] --prompt …` starts a cloud session directly on a GitHub repo.
- `atom cloud diff ID` shows a unified diff of the cloud working copy, and `atom cloud pr ID` commits, pushes and opens a pull request.
- `atom pull ID` brings any cloud session home, including sessions started from the web or handed off from a chat.
- Shared memory: when atom-cloud has a `SHARED` D1 binding, `atom cloud memory` merges your long-term memory with it both
  ways, and new cloud sessions start with those memories.
- atom-cloud API: `GET /api/sessions/:id/diff`, `POST /api/sessions/:id/pr`, `GET/POST /api/memory`, `GET /api/projects`,
  `GET /api/repos`; `POST /api/sessions` resolves a repo's default branch and records the session's source (cli/web/harness).

## v0.4.1
- Built-in GitHub sign-in: `atom login github` (also `atom cloud login`) uses OAuth device flow with the public
  "Atom CLI" app. Override it with `--github-client-id` or `ATOM_GITHUB_CLIENT_ID`. The token is stored in the OS keychain
  (macOS Keychain, libsecret) or in `~/.config/atom/github.json` with mode 0600, and is checked against GitHub.
  `atom logout github` removes it.
- `atom cloud push`, `ls`, `attach` and the other cloud commands use the stored token and start a sign-in automatically when needed.
- Atom Cloud web UI: "Sign in with GitHub" uses the GitHub web OAuth flow, protected by a signed state cookie and limited to
  the allowed user, when `GITHUB_CLIENT_SECRET` is set (`atom cloud setup --github-client-secret`). Otherwise
  the browser uses device flow. Pasting a token remains as a fallback.

## v0.4.0
- **Atom Cloud**: hand a session off to your own Cloudflare account and continue it there or in the browser.
  `atom cloud setup` deploys a Worker + Durable Object (one per session) running the Atom agent loop on Workers AI;
  `atom cloud login` signs in with GitHub (device flow with your own OAuth app, or your `gh`/GH_TOKEN credentials);
  `atom cloud push` / `/cloud` uploads messages, long-term memory, todos, branch and uncommitted files;
  `atom cloud ls | attach | pull | commit | rm`; web UI at your worker URL, restricted to one GitHub user.
  The cloud agent edits a copy of the repo and commits/pushes branches and opens PRs through the GitHub API.
- **Code graph** (tree-sitter WASM; TypeScript/TSX/JavaScript/Python/Go/Rust/Java): files and symbols with imports, calls,
  defines, inherits and type-reference edges, stored in `.atom/graph.json`, updated incrementally by content hash.
  New tools `find_symbol`, `find_callers`, `find_callees`, `impact_analysis`, `graph_neighborhood`; `atom graph` CLI with DOT/Mermaid export.
- **Hybrid search**: `semantic_search` now seeds with embeddings, expands along the code graph and reranks with
  `@cf/baai/bge-reranker-base` (rank fusion fallback). On an 18-question eval over a multi-language microservices repo:
  hit@5 50% → 78%, MRR@5 0.41 → 0.55 versus embeddings alone (`test/eval-hybrid.mjs`).
- `atom index` builds both the embedding index and the code graph. Embedding requests are batched by size.

## v0.3.1
- Published on npm as `@rclabs/atom` (`npm i -g @rclabs/atom`). `atom update` now uses the npm registry for npm installs.

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
