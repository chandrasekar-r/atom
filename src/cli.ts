import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { matchModel, saveUserModel } from "./config.js";
import { CONFIG_DIR, DEFAULT_MODEL, MODELS, clearCredentials, loadCredentials, loadSettings, resolveModel, Credentials } from "./config.js";
import { Agent, Decision, Mode, UI } from "./agent.js";
import { builtinTools, Tool } from "./tools.js";
import { McpClient } from "./mcp.js";
import { loadMemory } from "./memory.js";
import { listSessions, loadSession, newSession, saveSession, Session } from "./session.js";
import { loginApiToken, loginGateway, loginOAuth, loginWrangler, refreshIfNeeded } from "./login.js";
import { colorDiff } from "./diff.js";
import { runHooks } from "./hooks.js";
import { runShell } from "./tools.js";
import { runTui } from "./interactive.js";
import { st } from "./markdown.js";
import { LongTermMemory } from "./ltm.js";
import { RepoIndex } from "./repoindex.js";
import { loadSkills, skillTool, parseFrontmatter } from "./skills.js";
import { PluginHost } from "./plugins.js";
import { webSearchTool, webSearch } from "./websearch.js";
import { memoryTools, indexTools } from "./extratools.js";
import { expandMentions } from "./mentions.js";
import { addProject, listProjects, removeProject, switchProject, resolveProject, currentProject, projectContext, projectSettings, projectDir, Project } from "./projects.js";
import { CLASSIFIER_MODEL, EMBED_MODEL } from "./workersai.js";
import { execFileSync } from "node:child_process";
import { checkForUpdate, performUpdate, startupUpdateCheck, installDir } from "./update.js";

const VERSION = "0.3.1";
const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, bold: (s: string) => `\x1b[1m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`, red: (s: string) => `\x1b[31m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, magenta: (s: string) => `\x1b[35m${s}\x1b[0m` };

function parseArgs(argv: string[]) {
  const o: any = { _: [] as string[], allow: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") o.print = true;
    else if (a === "-m" || a === "--model") o.model = argv[++i];
    else if (a === "-c" || a === "--continue") o.continue = true;
    else if (a === "-r" || a === "--resume") o.resume = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
    else if (a === "--mode" || a === "--permission-mode") o.mode = argv[++i];
    else if (a === "--allow") o.allow.push(argv[++i]);
    else if (a === "--dangerously-skip-permissions" || a === "--yolo") o.mode = "bypass";
    else if (a === "--output-format") o.format = argv[++i];
    else if (a === "--token") o.token = argv[++i];
    else if (a === "--account") o.account = argv[++i];
    else if (a === "--gateway") o.gateway = argv[++i];
    else if (a === "--key") o.key = argv[++i];
    else if (a === "--oauth") o.oauth = true;
    else if (a === "--wrangler") o.wrangler = true;
    else if (a === "--simple" || a === "--no-tui") o.simple = true;
    else if (a === "--cwd") o.cwd = argv[++i];
    else if (a === "-P" || a === "--project") o.project = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : true;
    else if (a === "--no-memory") o.noMemory = true;
    else if (a === "--url") o.url = argv[++i];
    else if (a === "--header") (o.headers ||= []).push(argv[++i]);
    else if (a === "--global") o.global = true;
    else if (a === "--check") o.check = true;
    else if (a === "--quiet") o.quiet = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--dir") o.dir = argv[++i];
    else if (a === "--") { o.rest = argv.slice(i + 1); break; }
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else o._.push(a);
  }
  return o;
}

const HELP = `atom ${VERSION} - a terminal coding agent on your Cloudflare Workers AI

Usage:
  atom                       start interactive session in the current directory
  atom "fix the tests"       start a session with an initial prompt
  atom -p "question"         print mode: answer once and exit (stdin is appended)
  atom -c | --continue       continue the most recent session here
  atom -r [id]               resume a session (pick from a list if no id)
  atom login [--token T --account ID | --wrangler | --oauth | --gateway URL --key K]
  atom logout | atom whoami | atom models
  atom mcp list | atom mcp add NAME --url URL [--header K:V] | atom mcp add NAME -- CMD ARGS…  [--global]
  atom project add NAME [PATH] | list | switch NAME | show [NAME] | remove NAME
  atom index [--status | --clear]        build/refresh the semantic code index (bge-m3)
  atom memory [list | add TEXT | search Q | forget ID | sync | clear]
  atom update [--check]                  update from GitHub releases (gh auth / GH_TOKEN; git installs use git)
  atom skills | atom plugins | atom plugin install NPM_PKG | atom search QUERY

Options:
  -P, --project [NAME]       open a named project (default: the current one)
  --no-memory                disable long-term memory for this run
  -m, --model NAME           ${Object.keys(MODELS).join(", ")} or any @cf/... id
  --mode ask|auto|plan       permission mode (auto = accept file edits)
  --allow RULE               pre-allow a tool, e.g. --allow edit_file --allow "bash:npm test"
  --dangerously-skip-permissions   allow every tool without asking
  --output-format text|json  for -p
`;

const SLASH_LIST = [
  ["help", "show help"], ["clear", "start a fresh conversation"], ["compact", "summarize history [focus]"], ["model", "show or switch model"], ["cost", "token + neuron usage"],
  ["init", "write ATOM.md for this project"], ["resume", "switch to a past session"], ["rewind", "restore files + chat to before a turn"], ["tree", "session tree: branch from any message"],
  ["fork", "copy this conversation into a new session"], ["mode", "ask | auto | plan | bypass"], ["memory", "long-term memory: list | add | search | forget | sync | clear"], ["mcp", "list MCP tools"],
  ["skills", "list skills (/<skill> to run one)"], ["plugins", "list plugins"], ["agents", "custom subagents"], ["index", "refresh semantic code index"], ["project", "projects"],
  ["status", "account, model, session"], ["login", "credentials"], ["logout", "remove credentials"], ["exit", "quit"],
].map(([name, hint]) => ({ name, hint }));
const TUI_HELP = SLASH_LIST.map((x) => `  /${x.name.padEnd(9)} ${x.hint}`).join("\n") + `\n  Custom: .atom/commands/<name>.md -> /<name> [args]\n  Press ? on an empty prompt for keyboard shortcuts.`;
const SLASH_HELP = `Commands:
  /help              this help            /clear      start a fresh conversation
  /compact [focus]   summarize history    /model [m]  show or switch model
  /cost              token + neuron usage /init       write ATOM.md for this project
  /resume [id]       switch to a past session         /rewind [turn]  restore files + chat
  /mode [ask|auto|plan|bypass]  permission mode       /memory     show loaded memory files
  /skills /plugins /agents /index /project
  /mcp               list MCP tools       /status     account, model, session
  /login /logout     credentials          /exit       quit
  !<cmd>             run a shell command directly
  Custom: .atom/commands/<name>.md -> /<name> [args]  ($ARGUMENTS is replaced)
  Shift+Tab is not available in plain terminals: use /mode. Ctrl+C interrupts a running turn.`;

function customCommands(cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dir of [path.join(CONFIG_DIR, "commands"), path.join(cwd, ".atom", "commands")]) {
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) out[f.slice(0, -3)] = fs.readFileSync(path.join(dir, f), "utf8"); } catch {}
  }
  return out;
}

async function loadMcp(settings: any, ui: (s: string) => void): Promise<{ tools: Tool[]; clients: McpClient[] }> {
  const tools: Tool[] = [], clients: McpClient[] = [];
  for (const [name, cfg] of Object.entries<any>(settings.mcpServers || {})) {
    if (cfg.disabled) continue;
    try { const cl = new McpClient(name, cfg); clients.push(cl); const t = await cl.init(); tools.push(...t); ui(c.dim(`mcp: ${name} (${t.length} tools)`)); }
    catch (e: any) { ui(c.yellow(`mcp: ${name} failed: ${e.message}`)); }
  }
  return { tools, clients };
}

async function memoryCommand(ltm: LongTermMemory, line: string): Promise<string> {
  const [sub, ...r] = line.split(" "); const arg = r.join(" ").trim();
  if (sub === "add" && arg) { const m = await ltm.add(arg, "preference"); return m ? `saved [${m.id}] ${m.text}` : "nothing saved"; }
  if (sub === "search" && arg) { const h = await ltm.search(arg, 10, 0.3); return h.map((m) => `[${m.id}] ${m.score.toFixed(2)} ${m.text}`).join("\n") || "no matches"; }
  if ((sub === "forget" || sub === "rm") && arg) return `forgot ${ltm.forget(arg)} memories`;
  if (sub === "clear") { ltm.clear(); return "cleared all visible memories"; }
  if (sub === "sync") return await ltm.sync();
  const v = ltm.visible(); if (!v.length) return "No long-term memories yet. Say \"remember …\" or use /memory add TEXT.";
  return v.map((m) => `[${m.id}] ${m.scope === "global" ? "global " : "project"} ${m.kind.padEnd(10)} ${m.text}`).join("\n") + `\n(${v.length} memories · ${ltm.file} · classifier ${CLASSIFIER_MODEL} · embeddings ${EMBED_MODEL})`;
}

function customAgents(cwd: string): Record<string, { description: string; prompt: string; tools?: string[]; model?: string }> {
  const out: Record<string, any> = {};
  for (const dir of [path.join(CONFIG_DIR, "agents"), path.join(cwd, ".atom", "agents")]) {
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) { const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8")); out[meta.name || f.slice(0, -3)] = { description: meta.description || "", prompt: body.trim(), tools: meta.tools ? meta.tools.split(/[,\s]+/).filter(Boolean) : undefined, model: meta.model ? resolveModel(meta.model) : undefined }; } } catch {}
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.version) { console.log(VERSION); return; }
  if (o.help) { console.log(HELP); return; }
  let cwd = path.resolve(o.cwd || process.cwd());
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  let question = (q: string) => new Promise<string>((r) => rl.question(q, r));
  let say = (t: string) => console.log(t);
  const cmd = o._[0];
  try {
    if (cmd === "login") {
      if (o.gateway) await loginGateway(o.gateway, o.key || (await question("Gateway key: ")));
      else if (o.wrangler) await loginWrangler();
      else if (o.oauth) await loginOAuth();
      else await loginApiToken(question, o.token, o.account);
      console.log(c.green("Logged in. Credentials saved to ~/.config/atom/credentials.json")); return;
    }
    if (cmd === "logout") { clearCredentials(); console.log("Logged out."); return; }
    if (cmd === "models") { for (const [k, v] of Object.entries(MODELS)) console.log(`${k.padEnd(16)} ${v}${v === DEFAULT_MODEL ? "  (default)" : ""}`); return; }
    if (cmd === "whoami") { const cr = loadCredentials(); console.log(cr ? (cr.kind === "gateway" ? `gateway ${cr.url}` : `${cr.kind} account ${cr.accountId}`) : "not logged in"); return; }
    if (cmd === "mcp" && o._[1] === "add") {
      const name = o._[2]; if (!name || (!o.url && !o.rest?.length)) throw new Error("usage: atom mcp add NAME --url URL | atom mcp add NAME -- CMD ARGS");
      const f = o.global ? path.join(CONFIG_DIR, "settings.json") : path.join(cwd, ".atom", "settings.json");
      let j: any = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      const headers = Object.fromEntries((o.headers || []).map((h: string) => [h.split(":")[0].trim(), h.split(":").slice(1).join(":").trim()]));
      (j.mcpServers ||= {})[name] = o.url ? { url: o.url, ...(Object.keys(headers).length ? { headers } : {}) } : { command: o.rest[0], args: o.rest.slice(1) };
      fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(j, null, 2)); console.log(`added MCP server ${name} to ${f}`); return;
    }
    if (cmd === "mcp") { const { tools, clients } = await loadMcp(loadSettings(cwd), console.log); tools.forEach((t) => console.log(t.name)); clients.forEach((x) => x.close()); return; }
    if (cmd === "project") {
      const [, sub, a1, a2] = o._;
      if (sub === "add") { const p = addProject(a1, a2 || cwd); console.log(`project ${p.name} → ${p.root}\n  instructions: ${path.join(projectDir(p.name), "INSTRUCTIONS.md")}\n  knowledge:    ${path.join(projectDir(p.name), "knowledge")}/\n  settings:     ${path.join(projectDir(p.name), "settings.json")}`); return; }
      if (sub === "switch") { const p = switchProject(a1); console.log(`current project: ${p.name} (${p.root}). Open it with: atom -P`); return; }
      if (sub === "remove" || sub === "rm") { console.log(removeProject(a1) ? `removed ${a1} (files untouched)` : `no project ${a1}`); return; }
      if (sub === "show") { const p = a1 ? resolveProject(cwd, a1) : resolveProject(cwd) || currentProject(); if (!p) { console.log("no project"); return; } const ctx = projectContext(p); console.log(`${p.name}  ${p.root}\ndata: ${projectDir(p.name)}\ncontext files: ${ctx.files.length}\nsessions: ${listSessions(p.root).length}`); return; }
      const { current, projects } = listProjects(); if (!projects.length) console.log("No projects. atom project add NAME [PATH]");
      for (const p of projects) console.log(`${p.name === current ? "●" : " "} ${p.name.padEnd(18)} ${p.root}  ${c.dim(`${listSessions(p.root).length} sessions`)}`); return;
    }
    if (cmd === "update") {
      if (o.dir) process.env.ATOM_INSTALL_DIR = o.dir;
      if (o.check) { try { const r = await checkForUpdate(true); if (!o.quiet) console.log(r.available ? `update available: v${r.current} → v${r.latest!.version}${r.latest!.notes ? "\n\n" + r.latest!.notes : ""}` : `atom v${r.current} is up to date (latest v${r.latest!.version}, via ${r.latest!.source})`); } catch (e: any) { if (!o.quiet) throw e; } return; }
      const r = await performUpdate((m) => console.log(c.dim(m)), installDir());
      if (r.from === r.to) { console.log(`atom v${r.from} is already the latest`); return; }
      console.log(c.green(`updated atom v${r.from} → v${r.to}`) + (r.changelog ? `\n\nWhat's new:\n${r.changelog}` : "")); return;
    }
    if (cmd === "skills") { const ph = new PluginHost(cwd); await ph.load(loadSettings(cwd)); const sk = loadSkills(cwd, ph.skillDirs); sk.forEach((x) => console.log(`${x.name.padEnd(22)} ${x.description.slice(0, 90)}\n${" ".repeat(23)}${c.dim(x.file)}`)); if (!sk.length) console.log("No skills. Add .atom/skills/<name>/SKILL.md"); return; }
    if (cmd === "plugins" || (cmd === "plugin" && o._[1] !== "install")) { const ph = new PluginHost(cwd); await ph.load(loadSettings(cwd)); ph.plugins.forEach((p) => console.log(`${p.name.padEnd(20)} ${c.dim(p.source)}`)); ph.errors.forEach((e) => console.log(c.red(e))); if (!ph.plugins.length) console.log("No plugins."); console.log(c.dim(`tools: ${ph.tools.map((t) => t.name).join(", ") || "-"}  commands: ${Object.keys(ph.commands).map((x) => "/" + x).join(" ") || "-"}`)); return; }
    if (cmd === "plugin" && o._[1] === "install") {
      const pkg = o._[2]; const dir = path.join(CONFIG_DIR, "plugins"); fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(path.join(dir, "package.json"))) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "atom-plugins", private: true }, null, 2));
      execFileSync("npm", ["install", "--prefix", dir, pkg], { stdio: "inherit" });
      const f = path.join(CONFIG_DIR, "settings.json"); let j: any = {}; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
      const name = pkg.startsWith("@") ? "@" + pkg.slice(1).split("@")[0] : pkg.split("@")[0];
      j.plugins = [...new Set([...(j.plugins || []), name])]; fs.writeFileSync(f, JSON.stringify(j, null, 2)); console.log(c.green(`installed plugin ${name}`)); return;
    }
    if (cmd === "search") { const h = await webSearch(o._.slice(1).join(" ")); h.forEach((x, i) => console.log(`${i + 1}. ${x.title}\n   ${x.url}\n   ${c.dim(x.snippet)}`)); return; }
    if (cmd === "index" || cmd === "memory") {
      const cr = loadCredentials(); if (!cr) throw new Error("Not logged in. Run `atom login`.");
      const proj = o.project ? resolveProject(cwd, o.project === true ? currentProject()?.name : o.project) : resolveProject(cwd);
      const root = proj?.root || cwd;
      if (cmd === "index") {
        const idx = new RepoIndex(cr, root);
        if (o._[1] === "--clear" || o._[1] === "clear" || process.argv.includes("--clear")) { idx.clear(); console.log("index cleared"); return; }
        if (!process.argv.includes("--status")) { const t0 = Date.now(); const u = await idx.update((m) => process.stderr.write(`\r${m}   `)); process.stderr.write("\n"); console.log(`indexed ${root}: +${u.added} added, ~${u.changed} changed, -${u.removed} removed, ${u.chunks} chunks embedded with ${EMBED_MODEL} in ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
        const st2 = idx.stats(); console.log(`index: ${st2.files} files, ${st2.chunks} chunks, updated ${st2.updated ? new Date(st2.updated).toLocaleString() : "never"}\n  ${c.dim(st2.file)}`); return;
      }
      const ltm = new LongTermMemory(cr, proj ? `project:${proj.name}` : `dir:${root}`, loadSettings(cwd).memory || {});
      const [, sub, ...restA] = o._; const arg = restA.join(" ");
      console.log(await memoryCommand(ltm, sub ? `${sub} ${arg}`.trim() : "")); return;
    }
  } finally { if (["login", "logout", "models", "whoami", "mcp", "project", "skills", "plugins", "plugin", "search", "index", "memory", "update"].includes(cmd)) rl.close(); }

  let creds = loadCredentials();
  if (!creds) {
    if (o.print || !process.stdin.isTTY) { console.error("Not logged in. Run `atom login`."); process.exit(1); }
    console.log("Welcome to Atom. Log in with your Cloudflare account first.");
    creds = await loginApiToken(question);
  }
  creds = refreshIfNeeded(creds);
  let project: Project | null = null;
  try { project = o.project ? resolveProject(cwd, o.project === true ? currentProject()?.name : o.project) : resolveProject(cwd); } catch (e: any) { console.error(e.message); process.exit(1); }
  if (o.project && project) { cwd = project.root; process.chdir(cwd); }
  const settings: any = loadSettings(cwd);
  if (project) { const ps = projectSettings(project); for (const [k, v] of Object.entries(ps)) settings[k] = k === "allow" ? [...(settings.allow || []), ...(v as any)] : k === "mcpServers" || k === "hooks" ? { ...(v as any), ...(settings[k] || {}) } : k === "plugins" ? [...(v as any), ...(settings.plugins || [])] : settings[k] ?? v; }
  settings.allow = [...(settings.allow || []), ...o.allow];
  const model = resolveModel(o.model || settings.model || DEFAULT_MODEL);

  let session: Session = newSession(cwd, model);
  if (o.continue) session = listSessions(cwd)[0] || session;
  if (o.resume) {
    if (o.resume === true) {
      const ss = listSessions(cwd).slice(0, 15); ss.forEach((s, i) => console.log(`  ${i + 1}. ${new Date(s.updated).toLocaleString()}  ${s.title || "(untitled)"}  ${c.dim(s.id)}`));
      const pick = ss[+(await question("Resume which? ")) - 1]; if (pick) session = pick;
    } else session = loadSession(o.resume) || session;
  }
  if (o.model) session.model = model;

  let stdinText = "";
  if (o.print && !process.stdin.isTTY && (() => { try { const st = fs.fstatSync(0); return st.isFIFO() || st.isFile(); } catch { return false; } })()) { for await (const ch of process.stdin) stdinText += ch; }

  const print = !!o.print;
  const useTui = !print && process.stdin.isTTY && process.stdout.isTTY && !o.simple && !process.env.ATOM_SIMPLE;
  let atLineStart = true, inReason = false;
  const w = (s: string) => { process.stdout.write(s); atLineStart = s.endsWith("\n"); };
  const nl = () => { if (!atLineStart) w("\n"); };
  const ui: UI = {
    text: (t) => { if (print && o.format === "json") return; if (inReason) { w("\n"); inReason = false; } w(t); },
    reasoning: (t) => { if (print) return; if (!inReason) { nl(); w(c.dim("✻ ")); inReason = true; } w(c.dim(t)); },
    toolStart: (name, sum) => { if (inReason) { inReason = false; } nl(); if (!print) w(c.cyan(`⏺ ${name}`) + c.dim(`(${sum})`) + "\n"); },
    toolEnd: (name, res, ok) => {
      if (print) return;
      const lines = res.split("\n");
      const body = (name === "edit_file" || name === "write_file") && ok ? (lines.length > 1 ? lines[0] + "\n" + colorDiff(lines.slice(1, 40).join("\n")) : lines[0]) : c.dim(lines.slice(0, 6).join("\n") + (lines.length > 6 ? `\n… +${lines.length - 6} lines` : ""));
      w((ok ? "" : c.red("✗ ")) + body.split("\n").map((l) => "  ⎿ " + l).join("\n") + "\n");
    },
    ask: async (tool, preview) => {
      if (print || !process.stdin.isTTY) return "no";
      nl(); w(c.yellow(`\n? Allow ${tool.name}?\n`) + (tool.name === "bash" ? preview : colorDiff(preview)).split("\n").slice(0, 60).map((l) => "  │ " + l).join("\n") + "\n");
      const a = (await question(c.yellow("  [y]es / [a]lways (save to .atom/settings.json) / [n]o > "))).trim().toLowerCase();
      return (a.startsWith("a") ? "always" : a.startsWith("y") || a === "" ? "yes" : "no") as Decision;
    },
    info: (t) => { if (print) { process.stderr.write(t.replace(/\x1b\[[0-9;]*m/g, "") + "\n"); return; } nl(); console.log(process.env.NO_COLOR ? t.replace(/\x1b\[[0-9;]*m/g, "") : t); },
  };

  const mem = loadMemory(cwd);
  const pctx = project ? projectContext(project) : { text: "", files: [] };
  mem.files.unshift(...pctx.files);
  const mcp = await loadMcp(settings, print ? () => {} : console.log);
  const plugins = new PluginHost(cwd); await plugins.load(settings);
  if (!print) plugins.errors.forEach((e) => console.log(c.yellow(e)));
  const skills = () => loadSkills(cwd, plugins.skillDirs);
  const memOn = !o.noMemory && settings.memory?.enabled !== false;
  const ltm = memOn ? new LongTermMemory(creds, project ? `project:${project.name}` : `dir:${cwd}`, settings.memory || {}) : undefined;
  const repoIdx = new RepoIndex(creds, cwd);
  const extTools = [webSearchTool, skillTool(skills), ...(ltm ? memoryTools(ltm) : []), ...(settings.index?.enabled === false ? [] : indexTools(repoIdx, (m) => ui.info(c.dim(m))))];
  const mode: Mode = (o.mode || settings.permissionMode || "ask") as Mode;
  const agent = new Agent(creds, session, [...builtinTools, ...extTools, ...plugins.tools, ...mcp.tools], settings, ui, mode, mem.text,
    { ltm, plugins, skills, agents: customAgents(cwd), context: pctx.text ? `Project context (${project!.name}):\n${pctx.text}` : "", route: settings.memory?.route !== false });
  if (ltm && settings.memory?.sync) ltm.sync().catch(() => {});
  const cleanup = () => { saveSession(agent.session); mcp.clients.forEach((x) => x.close()); };

  if (print) {
    const prompt = [o._.join(" "), stdinText].filter(Boolean).join("\n\n");
    if (!prompt) { console.error("No prompt given."); process.exit(1); }
    rl.close();
    const ex = expandMentions(prompt, cwd); ex.files.forEach((f) => agent.readFiles.add(f)); ex.notes.forEach((n) => ui.info("  ⎿  " + n));
    const out = await agent.run(ex.text, ex.images);
    if (o.format === "json") console.log(JSON.stringify({ result: out, session_id: agent.session.id, model: agent.session.model, usage: agent.session.usage }));
    else nl();
    cleanup(); setTimeout(() => process.exit(0), 50).unref(); return;
  }

  const updateNote = print ? "" : startupUpdateCheck(!!(settings as any).autoUpdate);
  await runHooks(settings, "SessionStart", { session: session.id }, cwd);
  await plugins.emit("session_start", { session: session.id, cwd });
  if (!useTui) {
  console.log(c.magenta("✻ Atom") + c.dim(` v${VERSION}  ·  ${agent.session.model}  ·  mode: ${agent.mode}  ·  ${cwd}`));
  if (updateNote) console.log(c.yellow(`  ${updateNote}`));
  if (mem.files.length) console.log(c.dim(`  memory: ${mem.files.map((f) => path.relative(cwd, f) || f).join(", ")}`));
  if (session.messages.length) console.log(c.dim(`  resumed session ${session.id} (${session.messages.length} messages)`));
  console.log(c.dim("  /help for commands · Ctrl+C to interrupt · Ctrl+D to exit\n"));
  }

  let running = false;
  rl.on("SIGINT", () => { if (running) { agent.abort?.abort(); w(c.red("\n[interrupted]\n")); } else { cleanup(); process.exit(0); } });
  rl.on("close", () => { if (!running && !useTui) { cleanup(); process.exit(0); } });

  let tuiRunTurn: ((p: string) => Promise<void>) | null = null;
  const runTurn = async (p: string) => {
    if (tuiRunTurn) return tuiRunTurn(p);
    running = true;
    try { const ex = expandMentions(p, cwd); ex.notes.forEach((n) => ui.info(c.dim("  ⎿  " + n))); ex.files.forEach((f) => agent.readFiles.add(f)); await agent.run(ex.text, ex.images); } catch (e: any) { if (e.name !== "AbortError") ui.info(c.red("Error: " + e.message)); }
    running = false; nl(); saveSession(agent.session);
  };

  let pickModel: ((title: string, items: string[], idx: number) => Promise<number>) | null = null;
  const handleSlash = async (line: string): Promise<boolean> => {
    const [name, ...rest] = line.slice(1).split(" "); const arg = rest.join(" ").trim();
    const s = agent.session;
    switch (name) {
      case "help": say(useTui ? TUI_HELP : SLASH_HELP); const cc = Object.keys(customCommands(cwd)); if (cc.length) say("  Custom: " + cc.map((x) => "/" + x).join(" ")); return true;
      case "exit": case "quit": cleanup(); process.exit(0);
      case "clear": agent.session = newSession(cwd, s.model); agent.checkpoints.snaps = []; say(c.dim("(new conversation)")); return true;
      case "compact": { say(c.dim("compacting…")); const sum = await agent.compact(arg); say(c.dim(sum.slice(0, 600) + (sum.length > 600 ? "…" : ""))); saveSession(agent.session); return true; }
      case "model": {
        const keys = Object.keys(MODELS);
        const setModel = (m: string) => { s.model = m; saveUserModel(m); say(`model → ${m} ${c.dim("(saved as default)")}`); };
        if (arg) {
          const r = matchModel(arg);
          if (r.model) setModel(r.model);
          else if (r.candidates.length && pickModel) { const i = await pickModel(`"${arg}" matches several models: pick one`, r.candidates.map((k) => `${k.padEnd(18)} ${MODELS[k]}`), 0); if (i >= 0) setModel(MODELS[r.candidates[i]]); }
          else say(c.red(r.candidates.length ? `"${arg}" is ambiguous: ${r.candidates.join(", ")}` : `Unknown model "${arg}". Options: ${keys.join(", ")} (or a full @cf/… id)`));
          return true;
        }
        if (pickModel) {
          const cur = Math.max(0, keys.findIndex((k) => MODELS[k] === s.model));
          const items = keys.map((k) => `${MODELS[k] === s.model ? "●" : " "} ${k.padEnd(18)} ${c.dim(MODELS[k])}`);
          const i = await pickModel("Select model (↑↓ to move · enter to select · esc to cancel)", items, cur);
          if (i >= 0) setModel(MODELS[keys[i]]); else say(c.dim(`model unchanged: ${s.model}`));
        } else { Object.entries(MODELS).forEach(([k, v]) => say(`${v === s.model ? "●" : " "} ${k.padEnd(16)} ${v}`)); say(c.dim("Switch with /model NAME (partial names work)")); }
        return true;
      }
      case "cost": say(`tokens: ${s.usage.prompt} in / ${s.usage.completion} out · neurons: ${s.usage.neurons.toFixed(1)} (free allocation: 10,000/day)`); return true;
      case "mode": if (["ask", "auto", "plan", "bypass"].includes(arg)) agent.mode = arg as Mode; say(`mode: ${agent.mode}`); return true;
      case "memory": {
        if (!arg || arg === "files") say((mem.files.length ? "Instruction files:\n" + mem.files.map((f) => "  " + f).join("\n") : "No ATOM.md loaded. Run /init.") + "\n");
        if (arg !== "files") say(ltm ? await memoryCommand(ltm, arg) : "Long-term memory is off (--no-memory or settings.memory.enabled=false).");
        if (agent.lastRoute) say(c.dim(`last route: intent=${agent.lastRoute.intent} remember=${agent.lastRoute.remember.toFixed(2)} recall=${agent.lastRoute.recall.toFixed(2)}`));
        return true;
      }
      case "skills": { const sk = skills(); say(sk.length ? sk.map((x) => `  /${x.name.padEnd(20)} ${x.description.slice(0, 80)}`).join("\n") : "No skills. Add .atom/skills/<name>/SKILL.md"); return true; }
      case "plugins": say(plugins.plugins.length ? plugins.plugins.map((p) => `  ${p.name}  ${c.dim(p.source)}`).join("\n") : "No plugins."); return true;
      case "agents": { const ag = customAgents(cwd); say(Object.keys(ag).length ? Object.entries(ag).map(([k, v]) => `  ${k.padEnd(16)} ${v.description}`).join("\n") : "No custom agents. Add .atom/agents/<name>.md"); return true; }
      case "index": { if (arg === "clear") { repoIdx.clear(); say("index cleared"); return true; } say(c.dim("indexing…")); const u = await repoIdx.update(); const st2 = repoIdx.stats(); say(`index: +${u.added} ~${u.changed} -${u.removed} (${u.chunks} chunks embedded) · ${st2.files} files, ${st2.chunks} chunks total`); return true; }
      case "project": { const { current, projects } = listProjects(); say((project ? `active: ${project.name} (${project.root})\n` : "no active project (atom project add NAME)\n") + projects.map((p) => `${p.name === current ? "●" : " "} ${p.name.padEnd(16)} ${p.root}`).join("\n")); return true; }
      case "mcp": say(mcp.tools.map((t) => t.name).join("\n") || "No MCP servers. Add mcpServers to .atom/settings.json"); return true;
      case "status": say(`account: ${creds!.kind === "gateway" ? creds!.url : creds!.accountId} (${creds!.kind})\nmodel: ${s.model}\nmode: ${agent.mode}\nsession: ${s.id}\nturns: ${s.turn}`); return true;
      case "login": rl.pause(); await loginApiToken(question); return true;
      case "logout": clearCredentials(); say("Logged out."); return true;
      case "resume": {
        const ss = listSessions(cwd).filter((x) => x.id !== s.id).slice(0, 15);
        let pick: Session | null | undefined = arg ? loadSession(arg) : undefined;
        if (!pick) { ss.forEach((x, i) => say(`  ${i + 1}. ${new Date(x.updated).toLocaleString()}  ${x.title || "(untitled)"}`)); pick = ss[+(await question("Resume which? ")) - 1]; }
        if (pick) { saveSession(s); agent.session = pick; agent.checkpoints.snaps = pick.snapshots || []; say(c.dim(`resumed ${pick.id} (${pick.messages.length} messages)`)); }
        return true;
      }
      case "rewind": {
        const turns = agent.checkpoints.turns(); const userTurns = Object.keys(s.turnIndex).map(Number);
        if (!arg) { userTurns.forEach((t) => { const m = s.messages[s.turnIndex[t]]; say(`  ${t}. ${String(m?.content).slice(0, 70)}${turns.includes(t) ? c.dim("  [files]") : ""}`); }); }
        const t = +(arg || (await question("Rewind to before turn #: ")));
        if (t > 0) { const files = agent.rewind(t); say(c.green(`rewound to before turn ${t}`) + (files.length ? `; restored ${files.map((f) => path.relative(cwd, f)).join(", ")}` : "")); saveSession(agent.session); }
        return true;
      }
      case "fork": { saveSession(s); const f = newSession(cwd, s.model); f.messages = [...s.messages]; f.title = "fork: " + (s.title || ""); f.turn = s.turn; f.turnIndex = { ...s.turnIndex }; agent.session = f; saveSession(f); say(c.green(`forked into new session ${f.id}`)); return true; }
      case "tree": if (!useTui) { const { historyOutline } = await import("./session.js"); historyOutline(s as any).forEach((r, i) => say(`${String(i + 1).padStart(3)} ${"  ".repeat(r.depth)}${r.active ? "●" : "○"} ${r.label}`)); } return true;
      case "todos": say(s.messages.filter((m) => m.tool_calls?.some((t: any) => t.function.name === "todo_write")).length ? "see the latest todo_write output above" : "No todos yet."); return true;
      case "init": {
        await runTurn("Analyze this codebase and create (or improve) an ATOM.md file in the project root. It is loaded into every future session as project memory. Include: a one-paragraph overview, the build/test/lint/run commands, code layout, and key conventions. Keep it under 80 lines. Use glob/read_file to inspect; use write_file to save ATOM.md.");
        return true;
      }
      default: {
        const cc = { ...plugins.promptCommands, ...customCommands(cwd) };
        if (cc[name]) { await runTurn(cc[name].replace(/\$ARGUMENTS/g, arg)); return true; }
        if (plugins.commands[name]) { const r = await plugins.commands[name].run(arg, { cwd, say }); if (typeof r === "string" && r) say(r); return true; }
        const sk = skills().find((x) => x.name === name);
        if (sk) { await runTurn(`Use the "${sk.name}" skill (base directory: ${sk.dir}).\n\n${sk.body.trim()}\n\n${arg ? "Task: " + arg : ""}`); return true; }
        say(c.red(`Unknown command /${name}. Try /help`)); return true;
      }
    }
  };

  const initial = o._.join(" ");
  if (useTui) {
    rl.close();
    const t = await runTui({
      agent, cwd, version: VERSION,
      banner: [st.magenta("✻ ") + st.bold("Atom") + c.dim(` v${VERSION}`), c.dim(`  ${agent.session.model} · ${cwd}`), ...(mem.files.length ? [c.dim(`  memory: ${mem.files.map((f) => path.relative(cwd, f) || f).join(", ")}`)] : []), ...(session.messages.length ? [c.dim(`  resumed session ${session.id} (${session.messages.length} messages)`)] : []), c.dim("  ? for shortcuts · / for commands · @ to mention files · esc to interrupt")],
      commands: () => [...SLASH_LIST, ...Object.keys({ ...plugins.promptCommands, ...customCommands(cwd) }).map((n) => ({ name: n, hint: "custom command" })), ...Object.entries(plugins.commands).map(([n, x]) => ({ name: n, hint: x.description || "plugin command" })), ...skills().map((x) => ({ name: x.name, hint: "skill: " + x.description.slice(0, 50) }))],
      slash: async (l) => { await handleSlash(l); },
      shell: async (cmd) => { const r = await runShell(cmd, cwd); agent.session.messages.push({ role: "user", content: `[I ran: ${cmd}]\n${r.out.slice(0, 8000)}` }, { role: "assistant", content: "Noted." }); return r.out; },
      footerNote: () => updateNote, onExit: cleanup, onTurnEnd: () => saveSession(agent.session),
    }, initial || undefined);
    say = t.say; question = t.question; pickModel = t.select;
    tuiRunTurn = async (p) => { await t.submit(p); };
    await t.ready;
    await new Promise(() => {});
  }
  if (initial) await runTurn(initial);
  while (true) {
    const line = (await question(c.bold("> "))).trim();
    if (!line) continue;
    if (line.startsWith("/")) await handleSlash(line);
    else if (line.startsWith("!")) { const r = await runShell(line.slice(1), cwd); console.log(r.out.trimEnd()); agent.session.messages.push({ role: "user", content: `[I ran: ${line.slice(1)}]\n${r.out.slice(0, 8000)}` }, { role: "assistant", content: "Noted." }); }
    else await runTurn(line);
  }
}

main().catch((e) => { console.error(c.red(e.message)); process.exit(1); });
