// End-to-end tests against real Workers AI. Requires credentials: either
// ATOM_GATEWAY_URL+ATOM_GATEWAY_KEY or CLOUDFLARE_ACCOUNT_ID+ATOM_API_TOKEN (or a saved `atom login`).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import assert from "node:assert";
const BIN = path.resolve("bin/atom.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atom-e2e-"));
const cfg = process.env.ATOM_CONFIG_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "atom-cfg-"));
const env = { ...process.env, ATOM_CONFIG_DIR: cfg, NO_COLOR: "1" };
const strip = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
const log = (s) => process.stdout.write(s);

function p(args, input = "") { return execFileSync("node", [BIN, ...args], { cwd: dir, env, input, encoding: "utf8", timeout: 240000 }); }

/** Drive the interactive REPL through a pseudo-terminal (util-linux `script`). */
function repl() {
  const ch = spawn("script", ["-qfec", `node ${BIN}`, "/dev/null"], { cwd: dir, env: { ...env, COLUMNS: "120", ATOM_SIMPLE: "1" } });
  let buf = "";
  ch.stdout.on("data", (d) => { buf += d.toString(); log(strip(d.toString())); });
  return {
    async expect(re, ms = 180000) { const t0 = Date.now(); let from = this.mark || 0; while (Date.now() - t0 < ms) { const m = strip(buf).slice(from).match(re); if (m) { this.mark = from + m.index + m[0].length; return m; } await new Promise((r) => setTimeout(r, 200)); } throw new Error("timeout waiting for " + re); },
    send(s) { ch.stdin.write(s + "\r"); }, kill() { ch.kill(); }, mark: 0,
  };
}

const results = [];
async function test(name, fn) { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name + ": " + e.message]); } }

await test("print mode: edit + bash with allow rules", async () => {
  fs.writeFileSync(path.join(dir, "math.js"), "export const add=(a,b)=>a-b;\n");
  const out = p(["-p", "math.js has a bug in add. Fix it with edit_file, then verify with bash: node -e \"import('./math.js').then(m=>console.log(m.add(2,3)))\"", "--allow", "edit_file", "--allow", "bash:node *", "--output-format", "json"]);
  const j = JSON.parse(out.trim().split("\n").pop()); log(`\n[print] ${j.result}\n`);
  assert.match(fs.readFileSync(path.join(dir, "math.js"), "utf8"), /a\s*\+\s*b/);
});
await test("print mode denies unapproved writes", async () => {
  p(["-p", "Create a file named nope.txt containing hi using write_file."]);
  assert.ok(!fs.existsSync(path.join(dir, "nope.txt")));
});
await test("stdin piping + glob/grep", async () => {
  const out = p(["-p", "Using grep, which file in this directory defines `add`? Answer with just the filename."], "context: project root");
  assert.match(out, /math\.js/);
});

await test("interactive: permission prompt, diff, /cost, custom command, /rewind, /model, resume", async () => {
  fs.mkdirSync(path.join(dir, ".atom", "commands"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".atom", "commands", "shout.md"), "Reply with only the word $ARGUMENTS in uppercase. Do not use tools.");
  fs.writeFileSync(path.join(dir, "ATOM.md"), "# Project\nAlways end replies with the token ~atom~.\n");
  const r = repl();
  await r.expect(/Atom.*v0\.3\.0/); await r.expect(/memory: ATOM\.md/);
  await r.expect(/> /);
  r.send("Create hello.txt containing exactly the line: hello world. Use write_file.");
  await r.expect(/Allow write_file\?/); await r.expect(/\+ hello world/); await r.expect(/\[n\]o > /);
  r.send("y");
  await r.expect(/Created hello\.txt/); await r.expect(/~atom~/); await r.expect(/> /);
  assert.equal(fs.readFileSync(path.join(dir, "hello.txt"), "utf8").trim(), "hello world");
  r.send("/cost"); await r.expect(/neurons: \d/);
  r.send("/shout banana"); await r.expect(/BANANA/); await r.expect(/> /);
  r.send("/rewind 1"); await r.expect(/rewound to before turn 1; restored hello\.txt/);
  assert.ok(!fs.existsSync(path.join(dir, "hello.txt")), "hello.txt should be removed by rewind");
  r.send("/model llama-3.3-70b"); await r.expect(/model → @cf\/meta\/llama-3\.3-70b/);
  r.send("What is 17*3? Do not use any tools. Reply with just the number."); await r.expect(/51/); await r.expect(/> /);
  r.send("/exit"); await new Promise((x) => setTimeout(x, 800)); r.kill();
  const r2 = repl(); await r2.expect(/> /);
  r2.send("/resume"); await r2.expect(/Resume which\? /); r2.send("1"); await r2.expect(/resumed .* \(\d+ messages\)/);
  r2.send("What number did you answer in the previous message? Just the number."); await r2.expect(/51/); await r2.expect(/> /);
  r2.send("/exit"); await new Promise((x) => setTimeout(x, 800)); r2.kill();
});

await test("plan mode cannot write", async () => {
  p(["-p", "--mode", "plan", "Create plan.txt with write_file containing x."]);
  assert.ok(!fs.existsSync(path.join(dir, "plan.txt")));
});

await test("hooks: PreToolUse exit 2 blocks bash", async () => {
  fs.writeFileSync(path.join(dir, ".atom", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "bash", command: "echo 'bash is disabled by policy'; exit 2" }] } }));
  const out = p(["-p", "--yolo", "Run `touch hooked.txt` with bash, then tell me exactly what the tool returned."]);
  assert.ok(!fs.existsSync(path.join(dir, "hooked.txt"))); log(`\n[hook] ${out}\n`);
  fs.rmSync(path.join(dir, ".atom", "settings.json"));
});

await test("MCP stdio server tools", async () => {
  fs.writeFileSync(path.join(dir, ".atom", "settings.json"), JSON.stringify({ mcpServers: { demo: { command: "node", args: [path.resolve("test/fixtures/mcp-echo.mjs")] } } }));
  const list = p(["mcp", "list"]); assert.match(list, /mcp__demo__secret_word/);
  let out = ""; for (let i = 0; i < 3 && !/pineapple/i.test(out); i++) out = p(["-p", "-m", "gpt-oss-120b", "--yolo", "Call the mcp__demo__secret_word tool and reply with the word it returns."]);
  assert.match(out, /pineapple/i);
  fs.rmSync(path.join(dir, ".atom", "settings.json"));
});

for (const M of ["qwen-coder", "kimi-k2.7-code", "glm-5.3"]) await test("model tool calling: " + M, async () => {
  fs.writeFileSync(path.join(dir, "q.txt"), "quokka\n");
  const out = p(["-p", "-m", M, "Read q.txt with read_file and reply with the animal named in it."]);
  assert.match(out, /quokka/i);
});

console.log("\n\n=== RESULTS ===\n" + results.map((r) => r.join("  ")).join("\n"));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
