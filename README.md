# Atom

A terminal coding agent that runs on **your Cloudflare account's Workers AI** models. You log in with Cloudflare, and Atom reads and edits your code, runs commands, and keeps sessions you can resume. Every model it uses is a Workers AI model, which runs on your account's free daily neuron allocation.

Atom is original open-source software (MIT).

## Install

You need Node 22 or newer and **your own Cloudflare account**. The free plan works, since Workers AI includes 10,000 free neurons a day.

```bash
npm i -g @rclabs/atom
# or build from source
git clone https://github.com/chandrasekar-r/atom && cd atom && npm i && npm run build && npm link
```

## Log in with Cloudflare

Pick one of these:

| Command | What it does |
|---|---|
| `atom login` (recommended) | Opens a **pre-filled** dashboard link for a token with Workers AI Read + Edit and Account Settings Read. You click *Create Token* and paste it in. Atom detects your account and then **checks that the token can really run Workers AI** before saving anything. |
| `atom login --token T --account ID` | The same, but non-interactive. |
| `atom login --wrangler` | Reuses your own `wrangler login` OAuth session, or runs `wrangler login` in the browser for you. The token is refreshed through `wrangler whoami`. |
| `atom login --oauth` | A native OAuth 2.0 + PKCE browser flow with a localhost callback. It needs a Cloudflare OAuth client id in `ATOM_OAUTH_CLIENT_ID`. |
| `atom login --gateway URL --key K` | For advanced or owner setups only, and never the default. Uses a self-hosted gateway Worker (see `gateway/`) that exposes your account's AI binding behind a shared key. No API token ever leaves the Worker. |

Credentials are stored in `~/.config/atom/credentials.json` with mode 0600. For CI you can set `ATOM_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, or `ATOM_GATEWAY_URL` + `ATOM_GATEWAY_KEY`, instead.

## Use

```bash
atom                              # interactive session in this directory
atom "add a --json flag to cli.ts"
atom -p "explain src/agent.ts"    # print mode, then exit
git diff | atom -p "review this"  # stdin is appended to the prompt
atom -p --output-format json "..."  # {result, session_id, usage}
atom -c                           # continue the last session here
atom -r                           # pick a session to resume
atom -m kimi-k2.7-code            # choose a model
atom --mode plan | auto | ask     # permission mode
```

### Interactive TUI
Running `atom` in a terminal opens the full-screen interface. Use `--simple` or `ATOM_SIMPLE=1` for the old line REPL.

| Key | Action |
|---|---|
| `/` | command menu (fuzzy, Tab/Enter) |
| `@` | fuzzy file mention (text inlined, images attached) |
| `!cmd` | shell mode |
| `# note` | append to ATOM.md |
| Esc | interrupt the agent |
| Esc Esc | session tree: branch from any earlier message |
| Shift+Tab | cycle ask, auto (accept edits), plan and bypass |
| `\`+Enter, Alt+Enter, Shift+Enter, Ctrl+J | newline |
| ↑ / ↓ | history (persisted) |
| Ctrl+V | paste clipboard image (use `/model llama-4-scout`) |
| Ctrl+T | show/hide thinking |
| Ctrl+C ×2, Ctrl+D | exit |
| `?` | shortcuts |

Other features:
- The `task` tool runs subagents.
- Todos appear inline.
- Context compacts automatically near the limit.
- `/tree` and `/fork` work with session branches.
- `AGENTS.md` and `ATOM.md` are loaded as memory.

A recorded session is in `evidence/atom-tui.cast`, and you can play it with `asciinema play`.

### Models (`atom models`)

| Alias | Workers AI id |
|---|---|
| gpt-oss-120b (default) | @cf/openai/gpt-oss-120b |
| gpt-oss-20b | @cf/openai/gpt-oss-20b |
| llama-3.3-70b | @cf/meta/llama-3.3-70b-instruct-fp8-fast |
| kimi-k2.7-code | @cf/moonshotai/kimi-k2.7-code |
| glm-5.3 | @cf/zai-org/glm-5.3 |
| deepseek-v4-flash | @cf/deepseek-ai/deepseek-v4-flash-0731 |
| qwen3-30b | @cf/qwen/qwen3-30b-a3b-fp8 |
| qwen-coder | @cf/qwen/qwen2.5-coder-32b-instruct (Atom parses its text-format tool calls) |

You can also pass any `@cf/...` id.

### Tools

`read_file`, `write_file`, `edit_file` (exact-string replace, shown as a diff), `glob`, `grep`, `bash`, `web_fetch`, `todo_write`, and any tools from MCP servers you configure.

### Permissions

- **ask** (default): reads run freely. Writes, edits, `bash`, `web_fetch` and MCP calls show a preview (with a coloured diff for edits) and ask `[y]es / [a]lways / [n]o`. Answering **always** saves a rule to `.atom/settings.json`.
- **auto**: file edits are accepted automatically, and bash still asks.
- **plan**: only read-only tools are available. The model investigates and proposes a plan.
- **bypass**: `--dangerously-skip-permissions` allows everything.
- Pre-allow rules: `--allow edit_file --allow "bash:npm test" --allow "bash:git *"`.
- In `-p` mode, anything not pre-allowed is denied.

### Slash commands

`/help /clear /compact [focus] /model [m] /cost /init /resume [id] /rewind [turn] /mode /memory /mcp /status /login /logout /exit`, and `!cmd` runs a shell command directly.

- **/init** analyses the repo and writes `ATOM.md`.
- **/rewind N** restores every file changed since turn N and truncates the conversation to that point (file checkpoints).
- **/compact** replaces the history with a model-written summary. It also runs automatically when the context grows large.
- **Custom commands:** `.atom/commands/<name>.md` (or `~/.config/atom/commands/`) becomes `/<name> args`, and `$ARGUMENTS` in the file is replaced with the args.

### Memory

Atom loads `~/.config/atom/ATOM.md`, then every `ATOM.md`, `.atom/ATOM.md` and `ATOM.local.md` from your home directory down to the current directory. A line of the form `@path/file.md` imports that file.

### Settings, hooks, and MCP

User settings live in `~/.config/atom/settings.json`, project settings in `.atom/settings.json`:

```json
{
  "model": "gpt-oss-120b",
  "permissionMode": "ask",
  "allow": ["edit_file", "bash:npm test"],
  "hooks": {
    "PreToolUse":  [{ "matcher": "bash", "command": "./scripts/guard.sh" }],
    "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "npx prettier -w . >/dev/null; echo formatted" }],
    "UserPromptSubmit": [], "Stop": [], "SessionStart": []
  },
  "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } }
}
```

- Hooks receive their event JSON in `$ATOM_HOOK_INPUT`.
- A `PreToolUse` hook that exits with code 2 blocks the call, and its stdout is passed to the model as the reason.
- Hook stdout from `PostToolUse` and `UserPromptSubmit` is added to the context.
- MCP servers use stdio JSON-RPC, and their tools appear as `mcp__<server>__<tool>`.

Sessions are stored in `~/.config/atom/sessions/`, along with the conversation, usage and file snapshots.

## Atom Cloud (v0.4.0)

Continue a session in the cloud, on **your own** Cloudflare account, then pick it up from the browser or pull it back.

```bash
atom cloud setup --github-user YOUR_LOGIN            # deploy (or --domain cloud.example.com)
atom login github                                     # GitHub sign-in (device flow)
atom cloud push --prompt "finish the refactor and open a PR"   # or /cloud inside a session
atom cloud ls
atom cloud attach ID                                  # stream + type to continue
atom cloud pull ID                                    # session + branch back on your machine
```

- `setup` needs a Cloudflare token that can edit Workers (`CLOUDFLARE_API_TOKEN`, `--token`, or an existing `wrangler login`).
  It deploys one Worker with a SQLite Durable Object class (one object per session) and the Workers AI binding.
- Only the GitHub user given by `--github-user` can use the API or the web UI.
- GitHub sign-in is built in: `atom login github` runs device flow with the public Atom CLI OAuth app, and cloud commands
  prompt for it automatically. The token goes to your OS keychain or a 0600 file. To use your own OAuth app, pass `--github-client-id`
  (and `--github-client-secret` to `setup` for browser sign-in; set the app's callback to `https://<your worker>/auth/github/callback`).
  The token needs `repo` scope; the cloud agent uses it to read the repo, push branches and open pull requests.
- `push` sends the conversation, long-term memories, todos, the GitHub remote/branch/commit (pushing the branch first
  if the commit is not on GitHub yet) and the contents of uncommitted files.
- The cloud agent has file tools (list/read/write/edit/delete/grep), todos, web fetch, `git_commit_push` and
  `open_pull_request`. There is no shell in the cloud yet.

## Code graph and hybrid search (v0.4.0)

`atom index` also builds a tree-sitter code graph (TS/JS/Python/Go/Rust/Java) in `.atom/graph.json`.
The agent gets `find_symbol`, `find_callers`, `find_callees`, `impact_analysis` and `graph_neighborhood`,
and `semantic_search` becomes hybrid: embedding seeds → graph neighbours → Workers AI reranker.

```bash
atom graph stats
atom graph callers chargeCard
atom graph impact src/money.go
atom graph export PlaceOrder --format mermaid > graph.mmd
```

## New in v0.3.0

See [CHANGELOG.md](CHANGELOG.md) for the full list.

### Long-term memory
Atom remembers facts and preferences across sessions:
- **Storage:** `~/.config/atom/memory.json`. Memories are either global or scoped to the project or directory.
- **Routing:** each prompt is sent to Cloudflare's `@cf/cloudflare/clef-flash` decision model, which answers three questions:
  - `remember`: is this durable? If so, Llama 3.3 70B extracts the facts.
  - `recall`: would past preferences help?
  - `intent`: one of code, explain, web, memory or chat.
- **Recall:** relevant memories are found by cosine similarity over `@cf/baai/bge-m3` embeddings and attached to the turn.
- **Tools:** `memory_save`, `memory_search` and `memory_forget`.
- **Commands:** `/memory [list|add|search|forget|sync|clear]` and `atom memory …`.
- **Sync (optional):** set `"memory": {"sync": true}` to sync to D1 through the gateway (`/v1/memory`).
- **Turning it off:** `--no-memory` for one run, or `"memory": {"enabled": false}`.

### Web search
The `web_search` tool and `atom search QUERY` need no API key. They use DuckDuckGo's HTML endpoint and fall back to Bing RSS. Use `web_fetch` to read a page.

### MCP over stdio, HTTP and SSE
```bash
atom mcp add docs --url https://example.com/mcp --header "Authorization: Bearer …"   # Streamable HTTP (…/sse → legacy SSE)
atom mcp add fs -- npx -y @modelcontextprotocol/server-filesystem .                  # stdio
```
Atom handles paginated `tools/list`, `readOnlyHint` (read-only tools skip the permission prompt) and resources (`mcp__<server>__read_resource`). Add `--global` to write the server to the user settings instead of the project's.

### Plugins
A plugin is an ES module, either a local file or directory or an npm package:
```js
export default function (atom) {
  atom.registerTool({ name: "my_tool", description: "…", parameters: { type: "object", properties: {} }, readOnly: true, run: async (args) => "result" });
  atom.registerCommand("deploy", { description: "…", run: async (args, { say }) => "done" });
  atom.on("pre_tool", (e) => (e.tool === "bash" && /rm -rf/.test(e.input.command) ? { block: "not allowed" } : undefined));
  // events: session_start, user_prompt ({prompt}→{prompt?, context?, block?}), pre_tool, post_tool (return string to append), turn_end
}
```
- **Discovery:** Atom loads plugins from `~/.config/atom/plugins/*`, `.atom/plugins/*` and `"plugins": ["pkg" | "./path"]` in settings.
- **Install:** `atom plugin install <npm-pkg>`.
- **Bundled extras:** a plugin directory can ship its own `skills/` and `commands/`.

### Skills
Skills are `SKILL.md` folders (frontmatter `name` and `description`). Atom discovers them in:
- `.atom/skills` and `.agents/skills`, both in the project and in your home directory;
- `~/.config/atom/skills`;
- plugins.

Only the name and description go into the prompt. The model loads the full body with the `skill` tool when a task matches, and you can also run a skill as `/<skill> task`. List them with `atom skills`.

### Repo index and @-mentions
- **Indexing:** `atom index` chunks the repo (respecting `git ls-files` and .gitignore), embeds the chunks with bge-m3, and stores them in `~/.config/atom/index/`. Later runs only re-embed changed files. `--status` and `--clear` are also available.
- **Search tools:** `semantic_search` updates the index before each search. `repo_map` lists symbols per file.
- **Mentions:** `@file`, `@file:10-40`, `@dir/`, `@src/**/*.ts` and `@#SymbolName` (with TUI autocomplete), plus images. Each file is capped at 40 KB and the total at 150 KB.

### Projects
```bash
atom project add web ~/code/web     # creates ~/.config/atom/projects/web/{INSTRUCTIONS.md,knowledge/,settings.json}
atom project list | switch web | show web | remove web
atom -P web                         # open the current or named project from anywhere
```
- **Instructions and knowledge files** are added to the system prompt.
- **Project settings** are merged between your user settings and the repo's own settings.
- **Memory** is scoped to `project:<name>`.
- **Sessions** are tied to the project root.

### Custom subagents
Each `.atom/agents/<name>.md` file defines a subagent. Its frontmatter takes `name`, `description`, `tools` and `model`, and the body is the agent's instructions. The model runs these agents with `task(agent: "<name>")`, and `/agents` lists them.

### Updating
- **Manual:** `atom update` finds the newest GitHub release, using a token from `GH_TOKEN`/`GITHUB_TOKEN` or `gh auth token`. In a git checkout it fast-forwards or checks out the tag. Otherwise it downloads the release tarball and backs up the old install to `<dir>.bak-<version>`. Either way it then builds and prints the changelog.
- **Check only:** `atom update --check`.
- **Automatic:** a daily background check is cached in `~/.config/atom/update-check.json` and shown in the footer. With `"autoUpdate": true` the update installs in the background. Set `ATOM_DISABLE_AUTOUPDATE=1` to opt out.

## Gateway (optional)

`gateway/worker.js` is a small Worker with an `AI` binding and an `ATOM_KEY` secret. It serves:
- `/v1/chat/completions`;
- `/v1/run/<model>` for embeddings and the classifier;
- `/v1/memory` for D1 memory sync, when a `DB` D1 binding exists.

```bash
cd gateway && npx wrangler deploy && openssl rand -hex 24 | tee /dev/stderr | npx wrangler secret put ATOM_KEY
atom login --gateway https://atom-gateway.<you>.workers.dev --key <that key>
```

## Development

```bash
npm run build && npm test     # unit tests
npm run e2e                   # real Workers AI; needs credentials (env or saved login)
```
