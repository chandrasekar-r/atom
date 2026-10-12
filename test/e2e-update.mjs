// End-to-end: update real v0.2.0 installs (git checkout and non-git release tarball) to the latest GitHub release.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import assert from "node:assert";
const BIN = path.resolve("bin/atom.js"); const REPO = "https://github.com/chandrasekar-r/atom.git";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "atom-upd-")); const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "atom-updcfg-"));
const env = { ...process.env, ATOM_CONFIG_DIR: cfg, NO_COLOR: "1" }; delete env.ATOM_DISABLE_AUTOUPDATE; delete env.CI;
const sh = (c, a, cwd = root, e = env) => execFileSync(c, a, { cwd, env: e, encoding: "utf8", timeout: 600000, stdio: ["ignore", "pipe", "pipe"] });
const results = []; const log = (s) => process.stdout.write(s + "\n");
async function test(n, fn) { const t0 = Date.now(); try { await fn(); results.push(["PASS", `${n} (${((Date.now() - t0) / 1000).toFixed(0)}s)`]); } catch (e) { results.push(["FAIL", `${n}: ${String(e.stderr || "") + e.message}`.slice(0, 800)]); } log(results.at(-1).join("  ")); }
const token = sh("gh", ["auth", "token"]).trim();
const cloneAt = (dest, tag) => { sh("git", ["clone", "-q", "--branch", tag, `https://x-access-token:${token}@github.com/chandrasekar-r/atom.git`, dest]); sh("git", ["remote", "set-url", "origin", REPO], dest); sh("npm", ["install", "--no-audit", "--no-fund"], dest); sh("npm", ["run", "build"], dest); };
const gitDir = path.join(root, "git-install"); cloneAt(gitDir, "v0.2.0");
const gitEnv = { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/" };

await test("v0.2.0 install really is v0.2.0", async () => { assert.equal(sh("node", [path.join(gitDir, "bin/atom.js"), "--version"]).trim(), "0.2.0"); });
await test("atom update --check reports v0.2.0 → latest", async () => {
  const out = sh("node", [BIN, "update", "--check", "--dir", gitDir], root, gitEnv); log("  " + out.split("\n")[0]); assert.match(out, /update available: v0\.2\.0 → v0\.3\.\d/);
});
await test("startup notice in banner/footer from cached check (no network on startup)", async () => {
  const r = spawnSync("script", ["-qfec", `node ${BIN}`, "/dev/null"], { cwd: root, env: { ...gitEnv, ATOM_INSTALL_DIR: gitDir, ATOM_SIMPLE: "1", ATOM_GATEWAY_URL: "https://x", ATOM_GATEWAY_KEY: "x" }, input: "/exit\r", encoding: "utf8", timeout: 30000 });
  assert.match(r.stdout, /update v0\.3\.\d available · atom update/);
  const r2 = spawnSync("script", ["-qfec", `node ${BIN}`, "/dev/null"], { cwd: root, env: { ...gitEnv, ATOM_INSTALL_DIR: gitDir, ATOM_SIMPLE: "1", ATOM_DISABLE_AUTOUPDATE: "1", ATOM_GATEWAY_URL: "https://x", ATOM_GATEWAY_KEY: "x" }, input: "/exit\r", encoding: "utf8", timeout: 30000 });
  assert.doesNotMatch(r2.stdout, /available/, "ATOM_DISABLE_AUTOUPDATE opt-out");
});
await test("atom update (git install): v0.2.0 → v0.3.x with changelog", async () => {
  const out = sh("node", [BIN, "update", "--dir", gitDir], root, gitEnv); log("  " + out.split("\n").filter(Boolean).slice(0, 4).join(" | "));
  assert.match(out, /updated atom v0\.2\.0 → v0\.3\.\d/); assert.match(out, /What's new:[\s\S]*## v0\.3\.0[\s\S]*Long-term memory/); assert.doesNotMatch(out, /## v0\.2\.0/);
  assert.match(sh("node", [path.join(gitDir, "bin/atom.js"), "--version"]).trim(), /^0\.3\.\d/);
  assert.match(sh("node", [path.join(gitDir, "bin/atom.js"), "update", "--check"], root, gitEnv), /up to date/);
});
await test("atom update (non-git install via private release tarball + gh token)", async () => {
  const d = path.join(root, "tar-install"); const tmpc = path.join(root, "tmpc"); cloneAt(tmpc, "v0.2.0");
  fs.cpSync(tmpc, d, { recursive: true, filter: (s) => !s.includes(`${path.sep}.git`) });
  assert.equal(sh("node", [path.join(d, "bin/atom.js"), "--version"]).trim(), "0.2.0"); assert.ok(!fs.existsSync(path.join(d, ".git")));
  const out = sh("node", [BIN, "update", "--dir", d]); log("  " + out.split("\n").filter(Boolean).slice(0, 3).join(" | "));
  assert.match(out, /release tarball/); assert.match(out, /updated atom v0\.2\.0 → v0\.3\.\d/);
  assert.match(sh("node", [path.join(d, "bin/atom.js"), "--version"]).trim(), /^0\.3\.\d/); assert.ok(fs.existsSync(d + ".bak-0.2.0"));
});
await test("autoUpdate: true installs in the background on startup", async () => {
  const d = path.join(root, "auto-install"); cloneAt(d, "v0.2.0");
  const cfg2 = fs.mkdtempSync(path.join(os.tmpdir(), "atom-updcfg2-")); fs.writeFileSync(path.join(cfg2, "settings.json"), JSON.stringify({ autoUpdate: true }));
  const e2 = { ...gitEnv, ATOM_CONFIG_DIR: cfg2, ATOM_INSTALL_DIR: d, ATOM_SIMPLE: "1", ATOM_GATEWAY_URL: "https://x", ATOM_GATEWAY_KEY: "x" };
  sh("node", [BIN, "update", "--check", "--quiet"], root, e2); // seed the daily cache
  const r = spawnSync("script", ["-qfec", `node ${BIN}`, "/dev/null"], { cwd: root, env: e2, input: "/exit\r", encoding: "utf8", timeout: 30000 });
  assert.match(r.stdout, /updating to v0\.3\.\d in background/);
  const t0 = Date.now(); while (Date.now() - t0 < 300000 && !/^0\.3/.test(sh("node", [path.join(d, "bin/atom.js"), "--version"]).trim())) await new Promise((x) => setTimeout(x, 3000));
  assert.match(sh("node", [path.join(d, "bin/atom.js"), "--version"]).trim(), /^0\.3\.\d/); log("  " + fs.readFileSync(path.join(cfg2, "update.log"), "utf8").trim().split("\n").slice(-1)[0]);
});
console.log("\n=== RESULTS ===\n" + results.map((r) => r.join("  ")).join("\n"));
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
