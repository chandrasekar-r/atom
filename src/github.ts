import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { CONFIG_DIR, ensureDir } from "./config.js";

/** GitHub sign-in for Atom: OAuth device flow with the public "Atom CLI" app (override with ATOM_GITHUB_CLIENT_ID or --github-client-id).
 *  The token is kept in the OS keychain when one is available (macOS Keychain, libsecret), else in ~/.config/atom/github.json (0600). */
export const BUILTIN_CLIENT_ID = "Ov23liR9UOCfO9Pe75kG";
export const clientId = (o?: string) => o || process.env.ATOM_GITHUB_CLIENT_ID || BUILTIN_CLIENT_ID;
const SERVICE = "atom-cli", ACCOUNT = "github";
const FILE = () => path.join(CONFIG_DIR, "github.json");
const has = (bin: string) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
const keychain = (): "mac" | "secret-tool" | null => process.env.ATOM_NO_KEYCHAIN ? null : process.platform === "darwin" && has("security") ? "mac" : process.platform === "linux" && has("secret-tool") && (process.env.DBUS_SESSION_BUS_ADDRESS || process.env.DISPLAY) ? "secret-tool" : null;

export interface GithubAuth { token: string; login: string; store: "keychain" | "file" | "env" }
export function saveGithubToken(token: string, login: string): "keychain" | "file" {
  const k = keychain();
  try {
    if (k === "mac") { execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", token], { stdio: "ignore" }); }
    else if (k === "secret-tool") { execFileSync("secret-tool", ["store", "--label=Atom GitHub token", "service", SERVICE, "account", ACCOUNT], { input: token, stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }); }
    if (k) { ensureDir(CONFIG_DIR); fs.writeFileSync(FILE(), JSON.stringify({ login, store: "keychain" }), { mode: 0o600 }); return "keychain"; }
  } catch {}
  ensureDir(CONFIG_DIR); fs.writeFileSync(FILE(), JSON.stringify({ login, token, store: "file" }), { mode: 0o600 }); fs.chmodSync(FILE(), 0o600); return "file";
}
export function loadGithubAuth(): GithubAuth | null {
  if (process.env.ATOM_GITHUB_TOKEN) return { token: process.env.ATOM_GITHUB_TOKEN, login: "", store: "env" };
  let meta: any; try { meta = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return null; }
  if (meta.token) return { token: meta.token, login: meta.login, store: "file" };
  try {
    const t = process.platform === "darwin" ? execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      : execFileSync("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    return t ? { token: t, login: meta.login, store: "keychain" } : null;
  } catch { return null; }
}
export function clearGithubToken() {
  try { if (process.platform === "darwin") execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { stdio: "ignore" }); else execFileSync("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT], { stdio: "ignore", timeout: 5000 }); } catch {}
  fs.rmSync(FILE(), { force: true });
}
export async function githubUser(token: string): Promise<{ login: string; scopes: string } | null> {
  const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, "user-agent": "atom-cli" } });
  return r.ok ? { login: ((await r.json()) as any).login, scopes: r.headers.get("x-oauth-scopes") || "" } : null;
}
function openBrowser(url: string) { try { const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"; spawn(cmd, process.platform === "win32" ? ["/c", "start", url] : [url], { stdio: "ignore", detached: true }).unref(); } catch {} }

/** Device flow: print the code, open the browser, poll until authorised. */
export async function deviceCode(cid = clientId()): Promise<any> {
  const r = await fetch("https://github.com/login/device/code", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: cid, scope: "repo" }) });
  const d: any = await r.json(); if (!d.device_code) throw new Error("GitHub device flow: " + (d.error_description || d.error || r.status)); return d;
}
export async function githubDeviceLogin(o: { clientId?: string; log: (s: string) => void; open?: boolean }): Promise<GithubAuth> {
  const cid = clientId(o.clientId); const d = await deviceCode(cid);
  o.log(`Sign in to GitHub: open ${d.verification_uri} and enter code  ${d.user_code}`);
  if (o.open !== false && process.stdout.isTTY) openBrowser(d.verification_uri);
  let interval = (d.interval || 5) * 1000; const until = Date.now() + (d.expires_in || 900) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, interval));
    const j: any = await (await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: cid, device_code: d.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) })).json();
    if (j.access_token) return finish(j.access_token);
    if (j.error === "slow_down") interval += 5000; else if (j.error !== "authorization_pending") throw new Error("GitHub sign-in: " + (j.error_description || j.error));
  }
  throw new Error("GitHub sign-in timed out");
}
export async function githubTokenLogin(token: string): Promise<GithubAuth> { return finish(token); }
async function finish(token: string): Promise<GithubAuth> {
  const u = await githubUser(token); if (!u) throw new Error("GitHub rejected the token");
  return { token, login: u.login, store: saveGithubToken(token, u.login) };
}
/** Valid stored token, or interactive device-flow sign-in (when a TTY is attached). */
export async function ensureGithub(log: (s: string) => void, o: { clientId?: string; interactive?: boolean } = {}): Promise<GithubAuth> {
  const a = loadGithubAuth(); if (a) { const u = await githubUser(a.token); if (u) return { ...a, login: u.login }; log("stored GitHub token is no longer valid"); }
  if (o.interactive === false || !process.stdin.isTTY) throw new Error("GitHub sign-in needed: run `atom login github`");
  log("GitHub sign-in is needed for this."); return githubDeviceLogin({ clientId: o.clientId, log });
}
