import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, ensureDir } from "./config.js";
import { readWranglerToken } from "./login.js";
import { Session, newSession, saveSession } from "./session.js";
import { BUILTIN_CLIENT_ID, ensureGithub, githubDeviceLogin, githubTokenLogin, loadGithubAuth } from "./github.js";

/** Atom Cloud client: deploy the cloud worker to the user's own Cloudflare account, sign in with GitHub,
 *  hand a local session to the cloud, follow/continue it, and bring it back. */
export interface CloudConfig { url?: string; account?: string; script?: string; cookieSecret?: string; githubUser?: string; githubClientId?: string; github?: { token: string; login: string } }
const FILE = () => path.join(CONFIG_DIR, "cloud.json");
export function loadCloud(): CloudConfig { try { return JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { return {}; } }
export function saveCloud(c: CloudConfig) { ensureDir(CONFIG_DIR); fs.writeFileSync(FILE(), JSON.stringify(c, null, 2), { mode: 0o600 }); }
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).trim();
const sh = (cmd: string, a: string[]) => { try { return execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim(); } catch { return ""; } };
export const workerSource = () => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cloud", "worker.js"), "utf8");

// ---------------- setup: deploy to the user's own account ----------------
async function cf(token: string, p: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch("https://api.cloudflare.com/client/v4" + p, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) throw new Error(`Cloudflare ${init.method || "GET"} ${p}: ${r.status} ${JSON.stringify(j.errors || j).slice(0, 300)}`);
  return j.result;
}
export async function githubLoginFor(token: string): Promise<string | null> {
  const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${token}`, "user-agent": "atom-cli" } });
  return r.ok ? ((await r.json()) as any).login : null;
}
export interface SetupOpts { token?: string; account?: string; name?: string; domain?: string; githubUser?: string; githubClientId?: string; githubClientSecret?: string; log: (s: string) => void }
export async function cloudSetup(o: SetupOpts): Promise<CloudConfig> {
  const cfg = loadCloud();
  const token = o.token || process.env.CLOUDFLARE_API_TOKEN || readWranglerToken()?.token;
  if (!token) throw new Error("need a Cloudflare token that can edit Workers: pass --token, set CLOUDFLARE_API_TOKEN, or run `npx wrangler login` first");
  let account = o.account || process.env.CLOUDFLARE_ACCOUNT_ID || cfg.account;
  if (!account) { const a = await cf(token, "/accounts"); if (a.length !== 1) throw new Error(`token sees ${a.length} accounts; pass --account ID (${a.map((x: any) => `${x.id} ${x.name}`).join(", ")})`); account = a[0].id; }
  const githubUser = o.githubUser || cfg.githubUser || (await (async () => { const t = loadGithubAuth()?.token || process.env.GH_TOKEN || sh("gh", ["auth", "token"]); return t ? githubLoginFor(t) : null; })());
  if (!githubUser) throw new Error("which GitHub user may use this cloud? pass --github-user LOGIN");
  const script = o.name || cfg.script || "atom-cloud"; const cookieSecret = cfg.cookieSecret || crypto.randomBytes(32).toString("hex");
  const githubClientId = o.githubClientId || cfg.githubClientId || BUILTIN_CLIENT_ID; const secret = o.githubClientSecret || process.env.ATOM_GITHUB_CLIENT_SECRET;
  const bindings: any[] = [
    { type: "ai", name: "AI" },
    { type: "durable_object_namespace", name: "SESSIONS", class_name: "AtomSession" },
    { type: "plain_text", name: "ALLOWED_GITHUB_LOGIN", text: githubUser },
    { type: "secret_text", name: "COOKIE_SECRET", text: cookieSecret },
    { type: "plain_text", name: "GITHUB_CLIENT_ID", text: githubClientId },
    ...(secret ? [{ type: "secret_text", name: "GITHUB_CLIENT_SECRET", text: secret }] : []),
  ];
  const upload = async (migrations?: any) => {
    const fd = new FormData();
    fd.append("metadata", new Blob([JSON.stringify({ main_module: "worker.js", compatibility_date: "2025-09-01", bindings, ...(migrations ? { migrations } : {}) })], { type: "application/json" }));
    fd.append("worker.js", new Blob([workerSource()], { type: "application/javascript+module" }), "worker.js");
    return cf(token, `/accounts/${account}/workers/scripts/${script}`, { method: "PUT", body: fd });
  };
  o.log(`deploying worker "${script}" to account ${account}…`);
  try { await upload({ new_tag: "v1", new_sqlite_classes: ["AtomSession"] }); }
  catch (e: any) { if (!/migration|tag|already/i.test(e.message)) throw e; await upload(); }
  let url: string;
  if (o.domain) {
    const apex = o.domain.split(".").slice(-2).join(".");
    const zones = await cf(token, `/zones?name=${apex}&account.id=${account}`); if (!zones.length) throw new Error(`zone ${apex} not found in this account`);
    await cf(token, `/accounts/${account}/workers/domains`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: o.domain, service: script, zone_id: zones[0].id, environment: "production" }) });
    url = `https://${o.domain}`;
  } else {
    await cf(token, `/accounts/${account}/workers/scripts/${script}/subdomain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
    const sub = await cf(token, `/accounts/${account}/workers/subdomain`); url = `https://${script}.${sub.subdomain}.workers.dev`;
  }
  const next = { ...cfg, url, account, script, cookieSecret, githubUser, githubClientId };
  saveCloud(next); o.log(`Atom Cloud is at ${url} (only GitHub user ${githubUser} can sign in)`); return next;
}

// ---------------- auth ----------------
async function api(p: string, init: RequestInit = {}): Promise<any> {
  const c = loadCloud(); if (!c.url) throw new Error("Atom Cloud is not set up: run `atom cloud setup` (or `atom cloud use URL`)");
  const gh = await ensureGithub((s) => console.error(s), { clientId: c.githubClientId });
  const r = await fetch(c.url + p, { ...init, headers: { authorization: `Bearer ${gh.token}`, "content-type": "application/json", ...(init.headers || {}) } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p}: ${r.status} ${j.error || ""}`); return j;
}
export async function cloudLogin(o: { token?: string; clientId?: string; log: (s: string) => void }): Promise<string> {
  const c = loadCloud();
  const a = o.token ? await githubTokenLogin(o.token) : await githubDeviceLogin({ clientId: o.clientId || c.githubClientId, log: o.log });
  o.log(`GitHub token saved (${a.store === "keychain" ? "OS keychain" : "~/.config/atom/github.json, mode 0600"})`);
  if (c.url) await api("/api/me"); return a.login;
}

// ---------------- push / ls / attach / pull ----------------
export function repoInfo(cwd: string, log: (s: string) => void) {
  let remote = ""; try { remote = git(cwd, "remote", "get-url", "origin"); } catch { return null; }
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/); if (!m) return null;
  const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD"); const head = git(cwd, "rev-parse", "HEAD");
  let defaultBranch = "main"; try { defaultBranch = git(cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, ""); } catch {}
  // make sure the commit we build on exists on GitHub
  let onRemote = false; try { onRemote = !!git(cwd, "branch", "-r", "--contains", head); } catch {}
  if (!onRemote) { log(`pushing ${branch} to origin so the cloud can see commit ${head.slice(0, 7)}…`); execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd, stdio: ["ignore", "ignore", "pipe"] }); }
  // uncommitted work travels as file contents
  const files: Record<string, string> = {}; const deleted: string[] = [];
  const st = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  for (let i = 0; i < st.length; i++) {
    const code = st[i].slice(0, 2), f = st[i].slice(3); if (code[0] === "R") i++;
    const abs = path.join(cwd, f);
    if (!fs.existsSync(abs)) { deleted.push(f); continue; }
    const buf = fs.readFileSync(abs); if (buf.length > 500_000 || buf.includes(0)) { log(`skipping ${f} (binary or large)`); continue; }
    files[f] = buf.toString("utf8");
  }
  return { repo: { owner: m[1], name: m[2], branch: branch === "HEAD" ? defaultBranch : branch, commit: head, defaultBranch, base: defaultBranch }, files, deleted };
}
export function lastTodos(s: Session): any[] {
  for (let i = s.messages.length - 1; i >= 0; i--) for (const t of s.messages[i].tool_calls || []) if ((t as any).function?.name === "todo_write") { try { return JSON.parse((t as any).function.arguments).todos || []; } catch {} }
  return [];
}
export async function cloudPush(s: Session, o: { memory?: string[]; prompt?: string; model?: string; log: (s: string) => void }): Promise<{ id: string; url: string }> {
  const info = repoInfo(s.cwd, o.log);
  const msgs = s.messages.filter((m) => m.role !== "system").map((m) => ({ ...m, content: Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : m.content }));
  const body = { session: { title: s.title, model: o.model || s.model, cwd: s.cwd, messages: msgs }, memory: o.memory || [], todos: lastTodos(s), ...(info || {}) };
  const r = await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
  if (o.prompt) await api(`/api/sessions/${r.id}/messages`, { method: "POST", body: JSON.stringify({ text: o.prompt }) });
  o.log(`pushed ${msgs.length} messages${info ? `, ${Object.keys(info.files).length} changed files, repo ${info.repo.owner}/${info.repo.name}@${info.repo.branch}` : ""}`);
  return { id: r.id, url: `${loadCloud().url}/#${r.id}` };
}
export const cloudList = async () => (await api("/api/sessions")).sessions as any[];
export const cloudGet = (id: string) => api(`/api/sessions/${id}`);
export const cloudSend = (id: string, text: string) => api(`/api/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ text }) });
export const cloudCommit = (id: string, message: string, branch?: string) => api(`/api/sessions/${id}/commit`, { method: "POST", body: JSON.stringify({ message, branch }) });
export const cloudDelete = (id: string) => api(`/api/sessions/${id}`, { method: "DELETE" });
export function fmtEvent(e: any): string {
  const d = e.data || {};
  switch (e.type) {
    case "user": return `> ${d.text}`; case "assistant": return `⏺ ${d.text}`;
    case "tool": return `⏺ ${d.name}(${JSON.stringify(d.args).slice(0, 140)})`;
    case "tool_result": return `  ⎿ ${String(d.result).split("\n").slice(0, 3).join("\n    ")}`;
    case "pushed": return `⎇ pushed ${d.branch} ${String(d.commit).slice(0, 7)}`; case "pr": return `PR ${d.url}`;
    case "error": return `error: ${d.message}`; case "idle": return "(idle)"; case "created": return `(session created: ${d.messages} messages, ${d.files} files)`;
    default: return `(${e.type})`;
  }
}
/** Stream events until the session goes idle (when wait) or forever. */
export async function cloudFollow(id: string, print: (s: string) => void, o: { after?: number; untilIdle?: boolean; signal?: AbortSignal } = {}): Promise<number> {
  let after = o.after || 0; let sawRunning = false;
  while (!o.signal?.aborted) {
    const r = await api(`/api/sessions/${id}/events?after=${after}`);
    for (const e of r.events) { after = e.seq; print(fmtEvent(e)); if (o.untilIdle && e.type === "idle" && sawRunning) return after; if (e.type === "user") sawRunning = true; }
    if (o.untilIdle && r.status === "idle" && sawRunning && !r.events.length) return after;
    await new Promise((res) => setTimeout(res, 1200));
  }
  return after;
}
/** Bring a cloud session home: new local session with its messages; write changed files into cwd unless the cloud pushed a branch. */
export async function cloudPull(id: string, cwd: string, o: { files?: boolean; log: (s: string) => void }): Promise<Session> {
  const r = await cloudGet(id);
  const s = newSession(cwd, r.meta.model); s.title = (r.meta.title || "cloud session") + " (from cloud)"; s.messages = r.messages; s.turn = r.messages.filter((m: any) => m.role === "user").length;
  saveSession(s); o.log(`saved local session ${s.id} (${r.messages.length} messages). Resume with: atom -r ${s.id}`);
  if (r.meta.pushed) {
    o.log(`cloud pushed branch ${r.meta.pushed.branch} (${r.meta.pushed.commit.slice(0, 7)})${r.meta.pr ? ` · PR ${r.meta.pr}` : ""}`);
    if (o.files !== false) { try { git(cwd, "fetch", "origin", r.meta.pushed.branch); git(cwd, "checkout", "-B", r.meta.pushed.branch, "FETCH_HEAD"); o.log(`checked out ${r.meta.pushed.branch}`); } catch (e: any) { o.log(`could not check out the branch (${e.message.split("\n")[0]}); run: git fetch origin ${r.meta.pushed.branch}`); } }
  } else if (o.files !== false) {
    let n = 0; for (const [f, v] of Object.entries(r.files as Record<string, string | null>)) { const abs = path.join(cwd, f); if (v === null) { fs.rmSync(abs, { force: true }); } else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, v); } n++; }
    o.log(`applied ${n} file change(s) from the cloud working copy`);
  }
  return s;
}
export const cloudDiff = async (id: string) => (await api(`/api/sessions/${id}/diff`)).files as { path: string; status: string; patch: string }[];
export const cloudPR = (id: string, title?: string) => api(`/api/sessions/${id}/pr`, { method: "POST", body: JSON.stringify({ title }) });
export const cloudNew = (repo: string, o: { branch?: string; prompt?: string; title?: string }) => {
  const [owner, name] = repo.split("/"); return api("/api/sessions", { method: "POST", body: JSON.stringify({ source: "cli", title: o.title || o.prompt?.slice(0, 80) || repo, repo: { owner, name, ...(o.branch ? { branch: o.branch } : {}) } }) });
};
/** Two-way merge between local long-term memory and the shared store (a D1 database bound to atom-cloud as SHARED). */
export async function cloudMemorySync(local: { texts: () => string[]; add: (t: string) => Promise<unknown> }): Promise<{ pushed: number; pulled: number; shared: boolean }> {
  const r = await api("/api/memory"); if (!r.shared) return { pushed: 0, pulled: 0, shared: false };
  const remote: string[] = r.memories.map((m: any) => m.fact); const low = new Set(remote.map((x) => x.toLowerCase()));
  const mine = local.texts(); const mineLow = new Set(mine.map((x) => x.toLowerCase()));
  const toPush = mine.filter((t) => !low.has(t.toLowerCase()));
  const pushed = toPush.length ? (await api("/api/memory", { method: "POST", body: JSON.stringify({ facts: toPush, source: "atom-cli" }) })).added : 0;
  let pulled = 0; for (const t of remote) if (!mineLow.has(t.toLowerCase())) { await local.add(t); pulled++; }
  return { pushed, pulled, shared: true };
}
