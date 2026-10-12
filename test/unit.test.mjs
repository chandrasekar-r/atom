import test from "node:test"; import assert from "node:assert";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { lineDiff } from "../dist/diff.js";
import { globToRegex, builtinTools } from "../dist/tools.js";
import { Checkpoints } from "../dist/checkpoint.js";
import { parseTextToolCalls } from "../dist/provider.js";
import { loadMemory } from "../dist/memory.js";
import { resolveModel, DEFAULT_MODEL } from "../dist/config.js";
process.env.ATOM_CONFIG_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "atom-ucfg-"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "atom-u-"));
const T = Object.fromEntries(builtinTools.map((t) => [t.name, t]));
const ctx = (cwd) => ({ cwd, checkpoints: new Checkpoints(), turn: 1, readFiles: new Set() });

test("diff marks changes", () => { const d = lineDiff("a\nb\nc", "a\nB\nc"); assert.match(d, /- b/); assert.match(d, /\+ B/); });
test("glob", () => { assert.ok(globToRegex("src/**/*.ts").test("src/a/b.ts")); assert.ok(globToRegex("**/*.{js,ts}").test("x.ts")); assert.ok(!globToRegex("*.ts").test("a/b.ts")); });
test("edit requires unique match", async () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "f"), "x x"); const c = ctx(d);
  await assert.rejects(T.edit_file.run({ path: "f", old_string: "x", new_string: "y" }, c), /2 times/);
  await T.edit_file.run({ path: "f", old_string: "x", new_string: "y", replace_all: true }, c);
  assert.equal(fs.readFileSync(path.join(d, "f"), "utf8"), "y y");
});
test("checkpoint rewind restores and deletes", async () => {
  const d = tmp(); const c = ctx(d); fs.writeFileSync(path.join(d, "a"), "1");
  await T.write_file.run({ path: "a", content: "2" }, c); await T.write_file.run({ path: "b", content: "new" }, c);
  c.turn = 2; await T.write_file.run({ path: "a", content: "3" }, c);
  c.checkpoints.rewind(2); assert.equal(fs.readFileSync(path.join(d, "a"), "utf8"), "2");
  c.checkpoints.rewind(1); assert.equal(fs.readFileSync(path.join(d, "a"), "utf8"), "1"); assert.ok(!fs.existsSync(path.join(d, "b")));
});
test("grep + glob tools", async () => {
  const d = tmp(); fs.mkdirSync(path.join(d, "src")); fs.writeFileSync(path.join(d, "src/x.ts"), "const foo = 1\n");
  assert.match(await T.grep.run({ pattern: "foo", glob: "*.ts" }, ctx(d)), /src\/x\.ts:1:/);
  assert.match(await T.glob.run({ pattern: "**/*.ts" }, ctx(d)), /src\/x\.ts/);
});
test("text tool call recovery", () => {
  const r = parseTextToolCalls('<tools>\n{"name": "read_file", "arguments": {"path": "a"}}\n</tools>', ["read_file"]);
  assert.equal(r.calls[0].name, "read_file"); assert.equal(JSON.parse(r.calls[0].arguments).path, "a");
});
test("memory loads ATOM.md with imports", () => {
  const d = tmp(); fs.writeFileSync(path.join(d, "extra.md"), "imported-line"); fs.writeFileSync(path.join(d, "ATOM.md"), "top\n@extra.md\n");
  const m = loadMemory(d); assert.match(m.text, /imported-line/);
});
test("model aliases", () => { assert.equal(DEFAULT_MODEL, "@cf/openai/gpt-oss-120b"); assert.equal(resolveModel("llama-3.3-70b"), "@cf/meta/llama-3.3-70b-instruct-fp8-fast"); });

// ---- v0.2.0 TUI / tree units
import { renderMarkdown, wrapLine, visibleWidth } from "../dist/markdown.js";
import { parseKeys, fuzzy, Editor } from "../dist/tui.js";
import { newSession, recordHistory, rewindTo, historyOutline } from "../dist/session.js";
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
test("markdown renders headings, lists, fences (even unterminated)", () => {
  const out = renderMarkdown("# Title\n- a **b**\n```js\nconst x=1").map(plain);
  assert.equal(out[0], "Title"); assert.match(out[1], /• a b/); assert.match(out[2], /╭─ js/); assert.match(out[3], /│ const x=1/);
});
test("wrapLine respects width with ANSI", () => { for (const l of wrapLine("\x1b[1m" + "word ".repeat(40) + "\x1b[0m", 30)) assert.ok(visibleWidth(l) <= 30); });
test("parseKeys: shift-tab, esc, paste, enter", () => {
  assert.deepEqual(parseKeys("\x1b[Z\x1b\rq").map((k) => k.name), ["shift-tab", "alt-enter", "char"]);
  assert.equal(parseKeys("\x1b[200~hi\nthere\x1b[201~")[0].paste, "hi\nthere");
  assert.equal(parseKeys("\x1b")[0].name, "escape");
});
test("fuzzy ranks substring matches first", () => { assert.ok(fuzzy("mth", "src/math.js") >= 0); assert.equal(fuzzy("zz", "math.js"), -1); assert.ok(fuzzy("math", "math.js") < fuzzy("mth", "math.js")); });
test("editor: backslash-enter newline, history, slash completion", () => {
  const e = new Editor((t, p) => (/^\/\w*$/.test(t.slice(0, p)) ? { items: [{ value: "/compact", label: "/compact" }], start: 0 } : null));
  for (const ch of "a\\") e.key({ name: "char", seq: ch }); e.key({ name: "backspace", seq: "" }); e.key({ name: "char", seq: "\\" });
  assert.equal(e.key({ name: "enter", seq: "\r" }), "handled"); assert.equal(e.text, "a\n");
  e.set(""); e.key({ name: "char", seq: "/" }); assert.equal(e.sugg.length, 1); e.key({ name: "tab", seq: "\t" }); assert.equal(e.text, "/compact");
  e.pushHistory("one"); e.set(""); e.key({ name: "up", seq: "" }); assert.equal(e.text, "one");
});
test("history graph: re-editing a prompt forks, old version kept", () => {
  const s = newSession("/x", "m");
  s.messages.push({ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }, { role: "assistant", content: "a2" });
  let rows = historyOutline(s); assert.deepEqual(rows.map((r) => r.label), ["q1", "q2"]);
  assert.equal(rewindTo(s, rows[1].id), "q2"); assert.equal(s.messages.length, 2); assert.equal(s.turn, 1);
  s.messages.push({ role: "user", content: "q2-alt" }); recordHistory(s);
  rows = historyOutline(s); assert.equal(rows.length, 3);
  assert.ok(rows.find((r) => r.label === "q2" && !r.active && r.depth === 1)); assert.ok(rows.find((r) => r.label === "q2-alt" && r.active));
});
test("memory loads AGENTS.md", () => { const d = tmp(); fs.writeFileSync(path.join(d, "AGENTS.md"), "agents rule"); const m = loadMemory(d); assert.match(m.text, /agents rule/); });

// ---- v0.3.0
import { execFileSync, spawn } from "node:child_process";
import { expandMentions } from "../dist/mentions.js";
import { fileSymbols, repoSymbols, symbolBody, repoMap } from "../dist/symbols.js";
import { chunkText, listRepoFiles } from "../dist/repoindex.js";
import { loadSkills, parseFrontmatter, skillTool, skillsPrompt } from "../dist/skills.js";
import { PluginHost } from "../dist/plugins.js";
import { McpClient } from "../dist/mcp.js";
import { cosine } from "../dist/workersai.js";
import { systemPrompt } from "../dist/agent.js";
const repo = () => { const d = tmp(); execFileSync("git", ["init", "-q"], { cwd: d }); fs.mkdirSync(path.join(d, "src")); fs.writeFileSync(path.join(d, "src", "a.ts"), "import x from 'y';\nexport function alpha(n: number) {\n  return n + 1;\n}\nexport class Beta {\n  go() { return 2; }\n}\n"); fs.writeFileSync(path.join(d, "notes.md"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")); fs.writeFileSync(path.join(d, ".gitignore"), "secret/\n"); fs.mkdirSync(path.join(d, "secret")); fs.writeFileSync(path.join(d, "secret", "k.txt"), "nope"); return d; };

test("@ mentions: line range, directory, glob, symbol, budget notes", () => {
  const d = repo();
  const r = expandMentions("look at @notes.md:10-12 and @src/ and @src/*.ts and @#alpha", d);
  assert.match(r.text, /<file path="notes.md" lines="10-12">\nline 10\nline 11\nline 12\n<\/file>/);
  assert.match(r.text, /<directory path="src">\nsrc\/a.ts/);
  assert.match(r.text, /<file path="src\/a.ts">\nimport x/);
  assert.match(r.text, /lines="2-4">\nexport function alpha[\s\S]*return n \+ 1;\n}\n<\/file>/);
  assert.ok(!r.text.includes("secret/k.txt"), "gitignored files excluded");
  const big = tmp(); fs.writeFileSync(path.join(big, "b.txt"), "x".repeat(60000)); assert.match(expandMentions("@b.txt", big).text, /truncated: 60000 chars/);
});
test("symbols + repo map", () => { const d = repo(); const s = repoSymbols(d); assert.deepEqual(s.map((x) => x.name).sort(), ["Beta", "alpha"]); assert.match(symbolBody(d, s.find((x) => x.name === "Beta")), /go\(\)[\s\S]*}\n}$/); assert.match(repoMap(d), /src\/a.ts\n  2: export function alpha/); });
test("chunking overlaps + gitignore-aware listing", () => { const c = chunkText(Array.from({ length: 130 }, (_, i) => "l" + i).join("\n")); assert.deepEqual(c.map((x) => [x.start, x.end]), [[1, 60], [51, 110], [101, 130]]); assert.ok(!listRepoFiles(repo()).some((f) => f.startsWith("secret/"))); });
test("cosine", () => { assert.equal(cosine([1, 0], [1, 0]), 1); assert.equal(cosine([1, 0], [0, 1]), 0); });
test("skills: frontmatter, discovery, override, tool + prompt", async () => {
  assert.deepEqual(parseFrontmatter("---\nname: a\ndescription: b\n  more\n---\nbody").meta, { name: "a", description: "b more" });
  const d = tmp(); fs.mkdirSync(path.join(d, ".atom", "skills", "x"), { recursive: true }); fs.writeFileSync(path.join(d, ".atom", "skills", "x", "SKILL.md"), "---\nname: xskill\ndescription: does x\n---\nDo X carefully."); fs.writeFileSync(path.join(d, ".atom", "skills", "x", "run.sh"), "echo");
  const sk = loadSkills(d, [path.resolve("test/fixtures/plugin-demo/skills")]).filter((s) => !s.file.startsWith(os.homedir() + "/.") || s.file.includes(d));
  assert.ok(sk.some((s) => s.name === "xskill") && sk.some((s) => s.name === "release-haiku"));
  assert.match(skillsPrompt(sk), /- xskill: does x/);
  const out = await skillTool(() => sk).run({ name: "xskill" }, {}); assert.match(out, /base directory: .*\.atom\/skills\/x/); assert.match(out, /Bundled files: run\.sh/); assert.match(out, /Do X carefully/);
});
test("plugins: local dir plugin registers tool, command, hooks, skills, prompt commands", async () => {
  const d = tmp(); const ph = new PluginHost(d); await ph.load({ plugins: [path.resolve("test/fixtures/plugin-demo")] });
  assert.deepEqual(ph.errors, []); assert.equal(ph.plugins[0].name, "plugin-demo");
  assert.match(await ph.tools[0].run({ question: "hi" }), /ZEPHYR/); assert.equal(await ph.commands.ping.run("x", {}), "pong x");
  assert.deepEqual(await ph.emit("pre_tool", { tool: "bash", input: { command: "echo PLUGIN_BLOCK_ME" } }), [{ block: "demo plugin forbids this command" }]);
  assert.equal(ph.skillDirs.length, 1); assert.match(ph.promptCommands.pcmd, /plugin-command-ok/);
  // auto-discovery from .atom/plugins
  fs.mkdirSync(path.join(d, ".atom", "plugins"), { recursive: true }); fs.writeFileSync(path.join(d, ".atom", "plugins", "solo.mjs"), "export default (a) => a.registerCommand('solo', { run: () => 'solo-ok' });");
  const p2 = new PluginHost(d); await p2.load({}); assert.equal(await p2.commands.solo.run(""), "solo-ok");
});
test("projects: add, resolve by cwd, context, settings", async () => {
  process.env.ATOM_CONFIG_DIR; const P = await import("../dist/projects.js"); const d = repo();
  const p = P.addProject("unit-proj-" + process.pid, d, "Always answer in French.");
  assert.equal(P.resolveProject(path.join(d, "src")).name, p.name);
  fs.writeFileSync(path.join(P.projectDir(p.name), "knowledge", "glossary.md"), "FOO means bar");
  const ctx = P.projectContext(p); assert.match(ctx.text, /Always answer in French/); assert.match(ctx.text, /FOO means bar/);
  assert.ok(P.removeProject(p.name));
});
test("system prompt includes skills + project context", () => { const s = systemPrompt("/x", "", "ask", { skills: () => [{ name: "k", description: "kd", dir: "", file: "", body: "" }], context: "CTX-1" }); assert.match(s, /- k: kd/); assert.match(s, /CTX-1/); assert.match(s, /web_search/); });
for (const kind of ["http", "sse"]) test(`MCP over ${kind}: tools/list, tools/call, resources`, async () => {
  const srv = spawn("node", ["test/fixtures/mcp-http.mjs"]); const port = await new Promise((r) => srv.stdout.on("data", (d) => r(String(d).match(/PORT (\d+)/)[1])));
  const cl = new McpClient("w", { url: `http://127.0.0.1:${port}/${kind === "http" ? "mcp" : "sse"}` });
  try {
    const tools = await cl.init(); assert.equal(cl.transport, kind);
    const t = tools.find((x) => x.name === "mcp__w__weather_code"); assert.ok(t.readOnly);
    assert.equal(await t.run({ city: "Oslo" }), "code for Oslo: aurora-4");
    assert.match(await tools.find((x) => x.name === "mcp__w__read_resource").run({ uri: "demo://readme" }), /marmalade/);
    if (kind === "http") assert.equal(cl.sessionId, "s-1");
  } finally { cl.close(); srv.kill(); }
});
test("update: semver compare + changelog slicing", async () => {
  const U = await import("../dist/update.js");
  assert.ok(U.cmpVer("0.3.0", "0.2.0") > 0 && U.cmpVer("v0.10.0", "0.9.9") > 0 && U.cmpVer("1.0.0", "v1.0.0") === 0);
  const cl = "# Changelog\n\n## v0.4.0\n- d\n\n## v0.3.0\n- c\n\n## v0.2.0\n- b\n";
  assert.equal(U.changelogBetween(cl, "0.2.0", "0.3.0"), "## v0.3.0\n- c");
  assert.match(U.changelogBetween(cl, "0.2.0", "0.4.0"), /v0\.4\.0[\s\S]*v0\.3\.0/);
});
