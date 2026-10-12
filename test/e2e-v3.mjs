// v0.3.0 end-to-end tests against real Workers AI (gateway or API token): long-term memory, web search,
// MCP over HTTP/SSE, plugins, skills, repo index + semantic_search, @ mentions, projects, custom agents, D1 memory sync.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert";
const BIN = path.resolve("bin/atom.js"); const FIX = path.resolve("test/fixtures");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-e3-")); const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "atom-cfg3-"));
let env = { ...process.env, ATOM_CONFIG_DIR: cfg, NO_COLOR: "1" };
if (!env.ATOM_GATEWAY_KEY && fs.existsSync(".gateway_key")) Object.assign(env, { ATOM_GATEWAY_URL: "https://atom-gateway.rclabs.in", ATOM_GATEWAY_KEY: fs.readFileSync(".gateway_key", "utf8").trim() });
const run = (args, o = {}) => execFileSync("node", [BIN, ...args], { cwd: o.cwd || dir, env: o.env || env, encoding: "utf8", timeout: 300000, stdio: ["pipe", "pipe", "pipe"] });
import { spawnSync } from "node:child_process";
function require_spawn(args, o = {}) { const r = spawnSync("node", [BIN, ...args], { cwd: o.cwd || dir, env: o.env || env, encoding: "utf8", timeout: 300000 }); return { out: r.stdout, err: r.stderr }; }
const settings = (j) => { fs.mkdirSync(path.join(dir, ".atom"), { recursive: true }); fs.writeFileSync(path.join(dir, ".atom", "settings.json"), JSON.stringify(j)); };
const results = []; const log = (s) => process.stdout.write(s + "\n");
async function test(name, fn) { const t0 = Date.now(); try { await fn(); results.push(["PASS", `${name} (${((Date.now() - t0) / 1000).toFixed(0)}s)`]); } catch (e) { results.push(["FAIL", name + ": " + String(e.message).slice(0, 600)]); } log(results.at(-1).join("  ")); }
const retry = async (n, fn) => { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; } } throw e; };

execFileSync("git", ["init", "-q"], { cwd: dir });
fs.mkdirSync(path.join(dir, "src", "billing"), { recursive: true });
fs.writeFileSync(path.join(dir, "src", "billing", "invoice.ts"), "// Invoice helpers\nexport function computeTax(amountCents: number, rate: number): number {\n  // round half-up to whole cents for VAT\n  return Math.round(amountCents * rate);\n}\n");
fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export function login(user: string, password: string) {\n  return checkPassword(user, password);\n}\nfunction checkPassword(u: string, p: string) { return u.length > 0 && p.length > 7; }\n");
fs.writeFileSync(path.join(dir, "src", "ui.ts"), "export function renderButton(label: string) { return `<button>${label}</button>`; }\n");
fs.writeFileSync(path.join(dir, "notes.md"), Array.from({ length: 80 }, (_, i) => `note line ${i + 1}: ${["apple", "falcon", "granite", "harbor"][i % 4]}`).join("\n"));

await test("long-term memory: classifier auto-extracts, recalled in a new session, /memory list + forget", async () => {
  const r1 = require_spawn(["-p", "Please remember for all my future sessions: my favourite JavaScript test runner is vitest. Just acknowledge."]);
  log("  " + r1.err.trim().split("\n").join(" | "));
  const list = run(["memory"]); assert.match(list, /vitest/i, "memory not saved: " + list);
  const r2 = require_spawn(["-p", "Which test runner should you use when you add tests for me? Answer in one short line, no tools."]);
  log("  " + r2.err.trim() + " → " + r2.out.trim()); assert.match(r2.err, /recalled \d memor/); assert.match(r2.out, /vitest/i);
  assert.match(run(["memory", "search", "testing framework preference"]), /vitest/i);
  assert.match(run(["memory", "forget", "vitest"]), /forgot [1-9]/); assert.doesNotMatch(run(["memory"]), /vitest/i);
});
await test("memory_save tool when explicitly asked + Clef routes chit-chat as not memorable", async () => {
  const r = require_spawn(["-p", "Use the memory_save tool to remember that my deploy target is Cloudflare Workers (kind project). Then confirm."]);
  assert.match(run(["memory"]), /Cloudflare Workers/i);
  const r2 = require_spawn(["-p", "thanks, that's all"]); assert.doesNotMatch(r2.err, /remembered/);
});
await test("web search tool (keyless) is used for current info", async () => retry(2, async () => {
  const out = run(["-p", "Use web_search to find the official website domain of the pnpm package manager. Reply with just the domain."]);
  log("  → " + out.trim()); assert.match(out, /pnpm\.io/i);
}));
for (const kind of ["http", "sse"]) await test(`MCP over ${kind} (atom mcp add --url, agent calls tool)`, async () => {
  const srv = spawn("node", [path.join(FIX, "mcp-http.mjs")]); const port = await new Promise((r) => srv.stdout.on("data", (d) => r(String(d).match(/PORT (\d+)/)[1])));
  try {
    fs.rmSync(path.join(dir, ".atom", "settings.json"), { force: true });
    run(["mcp", "add", "wx", "--url", `http://127.0.0.1:${port}/${kind === "http" ? "mcp" : "sse"}`]);
    assert.match(run(["mcp", "list"]), /mcp__wx__weather_code/);
    const out = run(["-p", "--yolo", "Call the weather_code MCP tool for the city Oslo and reply with the code it returns."]); log("  → " + out.trim());
    assert.match(out, /aurora-4/);
  } finally { srv.kill(); fs.rmSync(path.join(dir, ".atom", "settings.json"), { force: true }); }
});
await test("plugin: tool used by agent, /command, prompt command, pre_tool block", async () => {
  settings({ plugins: [path.join(FIX, "plugin-demo")] });
  assert.match(run(["plugins"]), /plugin-demo/);
  const out = run(["-p", "Ask the dice oracle tool whether to ship today and reply with the oracle's answer word."]); log("  → " + out.trim()); assert.match(out, /ZEPHYR/);
  const out2 = run(["-p", "--yolo", "Use the bash tool to run exactly: echo PLUGIN_BLOCK_ME   Then quote exactly what the tool returned."]); log("  → " + out2.trim().slice(0, 200)); assert.match(out2, /forbid|block/i); assert.doesNotMatch(out2, /^PLUGIN_BLOCK_ME$/m);
});
await test("skill: plugin-bundled SKILL.md auto-invoked by the model", async () => retry(2, async () => {
  const out = run(["-p", "Write the release notes for version 1.2 (it adds dark mode) as a haiku."]); log("  → " + out.trim().replace(/\n/g, " / "));
  assert.match(out, /haiku-skill-used/);
}));
await test("project skill via /skills + `atom skills`", async () => {
  fs.mkdirSync(path.join(dir, ".atom", "skills", "commit-msg"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".atom", "skills", "commit-msg", "SKILL.md"), "---\nname: commit-msg\ndescription: Write a conventional commit message for staged changes.\n---\nAlways prefix with feat:, fix: or chore:.");
  const out = run(["skills"]); assert.match(out, /commit-msg/); assert.match(out, /release-haiku/);
});
await test("repo index: atom index (gitignore, incremental), semantic_search used by agent", async () => {
  fs.rmSync(path.join(dir, ".atom", "settings.json"), { force: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n"); fs.mkdirSync(path.join(dir, "ignored"), { recursive: true }); fs.writeFileSync(path.join(dir, "ignored", "x.ts"), "export const secretThing = 1;");
  const a = run(["index"]); log("  " + a.trim().split("\n")[0]); assert.match(a, /\+[4-9] added/);
  assert.match(run(["index"]), /\+0 added, ~0 changed, -0 removed, 0 chunks/);
  fs.appendFileSync(path.join(dir, "src", "ui.ts"), "export function renderLink(href: string) { return href; }\n");
  assert.match(run(["index"]), /\+0 added, ~1 changed/);
  const out = run(["-p", "Use the semantic_search tool (not grep) to find where VAT tax amounts get rounded to cents. Reply with just the file path."]); log("  → " + out.trim());
  assert.match(out, /src\/billing\/invoice\.ts/);
});
await test("@ mentions: line range, @#symbol, folder", async () => {
  const r = require_spawn(["-p", "Reply with only the single fruit/animal/word that appears in the attached lines. @notes.md:42-42"]); log("  " + r.err.trim() + " → " + r.out.trim());
  assert.match(r.err, /Read notes\.md:42-42/); assert.match(r.out, /falcon/i);
  const r2 = require_spawn(["-p", "Without using tools: what minimum password length does @#checkPassword accept? Reply with a number."]); log("  → " + r2.out.trim()); assert.match(r2.out, /\b8\b/);
  const r3 = require_spawn(["-p", "Without tools, list the file names in @src/ as a comma separated list."]); assert.match(r3.err, /Listed src\/ \(3 files\)/); assert.match(r3.out, /auth\.ts/);
});
await test("projects: add/list/switch, -P runs in root with instructions + knowledge, project-scoped memory", async () => {
  run(["project", "add", "e2eproj", dir]); assert.match(run(["project", "list"]), /e2eproj .*atom-e3-/);
  const pd = path.join(cfg, "projects", "e2eproj"); fs.writeFileSync(path.join(pd, "INSTRUCTIONS.md"), "# e2eproj\nEnd every reply with the token ~proj~.\n");
  fs.writeFileSync(path.join(pd, "knowledge", "codename.md"), "The internal codename of this project is BLUEHERON.");
  run(["project", "switch", "e2eproj"]);
  const out = run(["-P", "-p", "What is the project's internal codename? One word, no tools."], { cwd: os.tmpdir() }); log("  → " + out.trim());
  assert.match(out, /BLUEHERON/); assert.match(out, /~proj~/);
  assert.match(run(["project", "show", "e2eproj"]), /context files: 2/);
});
await test("custom agent (.atom/agents) via task tool", async () => retry(2, async () => {
  fs.mkdirSync(path.join(dir, ".atom", "agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".atom", "agents", "fruit.md"), "---\nname: fruit\ndescription: Knows the team's mascot fruit\ntools: read_file\n---\nThe team's mascot fruit is KUMQUAT. When asked, answer with that word.");
  const out = run(["-p", "--yolo", "Use the task tool with agent \"fruit\" to ask what the team's mascot fruit is, then reply with its answer."]); log("  → " + out.trim());
  assert.match(out, /KUMQUAT/i);
}));
await test("memory sync to D1 through the gateway (second machine pulls)", async () => {
  if (!env.ATOM_GATEWAY_KEY) throw new Error("needs gateway");
  const tag = "e2e-sync-" + Date.now();
  settings({ memory: { sync: true } });
  run(["memory", "add", `User's lucky number for test ${tag} is 4242`]); assert.match(run(["memory", "sync"]), /synced/);
  const cfg2 = fs.mkdtempSync(path.join(os.tmpdir(), "atom-cfg3b-"));
  const env2 = { ...env, ATOM_CONFIG_DIR: cfg2 };
  const s2 = run(["memory", "sync"], { env: env2 }); assert.match(s2, /pulled [1-9]/);
  assert.match(run(["memory"], { env: env2 }), new RegExp(tag));
  run(["memory", "forget", tag], { env: env2 }); run(["memory", "sync"], { env: env2 }); run(["memory", "sync"]);
  assert.doesNotMatch(run(["memory"]), new RegExp(tag));
  fs.rmSync(path.join(dir, ".atom", "settings.json"), { force: true });
});

await test("login (BYO Cloudflare account): bogus token rejected; token without Workers AI is detected; nothing saved", async () => {
  const c3 = fs.mkdtempSync(path.join(os.tmpdir(), "atom-login-")); const e3 = { ...process.env, ATOM_CONFIG_DIR: c3, NO_COLOR: "1" }; delete e3.ATOM_GATEWAY_KEY; delete e3.ATOM_GATEWAY_URL;
  const r = spawnSync("node", [BIN, "login", "--token", "bogus-token-123"], { env: e3, encoding: "utf8", input: "", timeout: 60000 });
  assert.match(r.stderr + r.stdout, /rejected this token[\s\S]*permissionGroupKeys=.*workers_ai/); assert.ok(!fs.existsSync(path.join(c3, "credentials.json")));
  if (process.env.CLOUDFLARE_API_TOKEN) {
    const r2 = spawnSync("node", [BIN, "login", "--token", process.env.CLOUDFLARE_API_TOKEN], { env: e3, encoding: "utf8", input: "", timeout: 60000 });
    const out = (r2.stdout + r2.stderr).replaceAll(process.env.CLOUDFLARE_API_TOKEN, "***"); log("  " + out.split("\n").slice(0, 2).join(" | ").slice(0, 200));
    assert.match(out, /Account: .*\([0-9a-f]{32}\)/); assert.match(out, /Logged in|no Workers AI permission/);
    if (/no Workers AI permission/.test(out)) assert.ok(!fs.existsSync(path.join(c3, "credentials.json")));
  }
});

console.log("\n=== RESULTS ===\n" + results.map((r) => r.join("  ")).join("\n"));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
