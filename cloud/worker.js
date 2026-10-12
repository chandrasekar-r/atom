// Atom Cloud: continue Atom coding sessions in your own Cloudflare account.
// One Durable Object per session keeps the conversation, an overlay of edited files on top of a GitHub branch,
// and an event log. The agent loop runs inside the Durable Object on Workers AI. Repository access uses the
// GitHub token of the single allowed GitHub user. Deployed by `atom cloud setup`.
const GH = "https://api.github.com";
const MODEL_DEFAULT = "@cf/openai/gpt-oss-120b";
const json = (d, s = 200, h = {}) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", ...h } });
const enc = new TextEncoder();
async function hmac(secret, data) { const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
async function gh(token, path, init = {}) {
  const r = await fetch(path.startsWith("http") ? path : GH + path, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atom-cloud", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`GitHub ${init.method || "GET"} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : r.json();
}
const b64 = (s) => { const bytes = enc.encode(s); let bin = ""; for (const x of bytes) bin += String.fromCharCode(x); return btoa(bin); };
const unb64 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

// ---------- auth: only the configured GitHub user ----------
const userCache = new Map();
async function githubLogin(token) {
  const hit = userCache.get(token); if (hit && hit.exp > Date.now()) return hit.login;
  const r = await fetch(GH + "/user", { headers: { authorization: `Bearer ${token}`, "user-agent": "atom-cloud" } });
  if (!r.ok) return null; const u = await r.json(); userCache.set(token, { login: u.login, exp: Date.now() + 300_000 }); return u.login;
}
async function authed(req, env) {
  const allowed = (env.ALLOWED_GITHUB_LOGIN || "").toLowerCase(); if (!allowed) return null;
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (bearer) { const login = await githubLogin(bearer); return login && login.toLowerCase() === allowed ? { login, token: bearer } : null; }
  const cookie = /(?:^|;\s*)atom_session=([^;]+)/.exec(req.headers.get("cookie") || "")?.[1];
  if (!cookie) return null;
  const [payload, sig] = decodeURIComponent(cookie).split("."); if (!payload || sig !== await hmac(env.COOKIE_SECRET, payload)) return null;
  const s = JSON.parse(atob(payload)); if (s.exp < Date.now() || s.login.toLowerCase() !== allowed) return null;
  return { login: s.login, token: s.token };
}
async function makeCookie(env, login, token) {
  const payload = btoa(JSON.stringify({ login, token, exp: Date.now() + 7 * 86400_000 }));
  return `atom_session=${encodeURIComponent(payload + "." + await hmac(env.COOKIE_SECRET, payload))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url); const p = url.pathname;
    if (p === "/health") return json({ ok: true, service: "atom-cloud", deviceFlow: !!env.GITHUB_CLIENT_ID, user: env.ALLOWED_GITHUB_LOGIN || null });
    if (p === "/" || p === "/ui") return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
    // GitHub device flow (needs your own OAuth app's client id with device flow enabled)
    if (p === "/auth/device" && req.method === "POST") {
      if (!env.GITHUB_CLIENT_ID) return json({ error: "device flow not configured (GITHUB_CLIENT_ID)" }, 501);
      const r = await fetch("https://github.com/login/device/code", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, scope: "repo" }) });
      return json(await r.json());
    }
    if (p === "/auth/device/poll" && req.method === "POST") {
      const { device_code } = await req.json();
      const r = await (await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }) })).json();
      if (!r.access_token) return json(r, 202);
      return finishLogin(env, r.access_token);
    }
    if (p === "/auth/token" && req.method === "POST") { const { token } = await req.json(); return finishLogin(env, token); }
    if (p === "/auth/logout") return new Response(null, { status: 302, headers: { location: "/", "set-cookie": "atom_session=; Path=/; Max-Age=0" } });

    if (!p.startsWith("/api/")) return new Response("not found", { status: 404 });
    const who = await authed(req, env); if (!who) return json({ error: "unauthorized: sign in with GitHub as " + (env.ALLOWED_GITHUB_LOGIN || "(unset)") }, 401);
    if (p === "/api/me") return json({ login: who.login });
    const index = env.SESSIONS.get(env.SESSIONS.idFromName("__index__"));
    if (p === "/api/sessions" && req.method === "GET") return index.fetch("https://do/index/list");
    if (p === "/api/sessions" && req.method === "POST") {
      const body = await req.json(); const id = body.id || crypto.randomUUID().slice(0, 12);
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(id));
      const r = await stub.fetch("https://do/create", { method: "POST", body: JSON.stringify({ ...body, id, githubToken: who.token, login: who.login }) });
      if (r.ok) await index.fetch("https://do/index/put", { method: "POST", body: JSON.stringify({ id, title: body.session?.title || "", repo: body.repo ? `${body.repo.owner}/${body.repo.name}` : "", branch: body.repo?.branch || "", created: Date.now() }) });
      return r;
    }
    const m = /^\/api\/sessions\/([\w-]+)(\/.*)?$/.exec(p); if (!m) return json({ error: "not found" }, 404);
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(m[1]));
    const sub = m[2] || "/";
    if (sub === "/" && req.method === "DELETE") { await index.fetch("https://do/index/del", { method: "POST", body: JSON.stringify({ id: m[1] }) }); return stub.fetch("https://do/delete", { method: "POST" }); }
    const fwd = new Request("https://do" + sub + url.search, req);
    fwd.headers.set("x-github-token", who.token);
    return stub.fetch(fwd);
  },
};
async function finishLogin(env, token) {
  const login = await githubLogin(token);
  if (!login || login.toLowerCase() !== (env.ALLOWED_GITHUB_LOGIN || "").toLowerCase()) return json({ error: `GitHub user ${login || "?"} is not allowed on this Atom Cloud` }, 403);
  return json({ ok: true, login }, 200, { "set-cookie": await makeCookie(env, login, token) });
}

// ---------- tools available to the cloud agent ----------
const TOOLS = [
  { name: "list_files", description: "List repository files (optionally under a path prefix).", parameters: { type: "object", properties: { prefix: { type: "string" } } } },
  { name: "read_file", description: "Read a file from the repository working copy (with your edits applied).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "Create or overwrite a file.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace a unique exact string in a file.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } },
  { name: "delete_file", description: "Delete a file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "grep", description: "Search file contents with a regular expression (max 300 files).", parameters: { type: "object", properties: { pattern: { type: "string" }, prefix: { type: "string" } }, required: ["pattern"] } },
  { name: "todo_write", description: "Record the task checklist (full list each time).", parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string" } } } } }, required: ["todos"] } },
  { name: "git_commit_push", description: "Commit all your file changes to a branch on GitHub (creates the branch from the session's base if needed).", parameters: { type: "object", properties: { message: { type: "string" }, branch: { type: "string" } }, required: ["message"] } },
  { name: "open_pull_request", description: "Open a pull request from the session's pushed branch.", parameters: { type: "object", properties: { title: { type: "string" }, body: { type: "string" }, base: { type: "string" } }, required: ["title"] } },
  { name: "web_fetch", description: "Fetch a URL and return its text.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

export class AtomSession {
  constructor(state, env) { this.state = state; this.env = env; this.sql = state.storage.sql; this.sockets = new Set(); }
  async get(k, d) { return (await this.state.storage.get(k)) ?? d; }
  async put(k, v) { await this.state.storage.put(k, v); }
  async event(type, data) {
    const seq = (await this.get("seq", 0)) + 1; await this.put("seq", seq);
    const ev = { seq, type, data, at: Date.now() }; await this.put("ev:" + String(seq).padStart(8, "0"), ev);
    for (const ws of this.state.getWebSockets()) { try { ws.send(JSON.stringify(ev)); } catch {} }
    return ev;
  }
  async fetch(req) {
    const url = new URL(req.url); const p = url.pathname;
    if (p.startsWith("/index/")) return this.indexOp(p, req);
    if (p === "/create") {
      const b = await req.json();
      await this.state.storage.deleteAll();
      const s = b.session || {};
      await this.put("meta", { id: b.id, login: b.login, title: s.title || "", model: s.model || MODEL_DEFAULT, repo: b.repo || null, created: Date.now(), status: "idle", pushed: null, pr: null, cwd: s.cwd || "" });
      await this.put("token", b.githubToken);
      await this.put("messages", s.messages || []);
      await this.put("memory", b.memory || []);
      await this.put("todos", b.todos || []);
      for (const [path, content] of Object.entries(b.files || {})) await this.put("f:" + path, content);
      for (const path of b.deleted || []) await this.put("f:" + path, null);
      await this.event("created", { messages: (s.messages || []).length, files: Object.keys(b.files || {}).length, repo: b.repo });
      return json({ id: b.id, ok: true });
    }
    if (p === "/delete") { await this.state.storage.deleteAll(); return json({ ok: true }); }
    if (p === "/ws") {
      const pair = new WebSocketPair(); this.state.acceptWebSocket(pair[1]); return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const meta = await this.get("meta"); if (!meta) return json({ error: "no such session" }, 404);
    if (p === "/" && req.method === "GET") {
      const files = {}; const list = await this.state.storage.list({ prefix: "f:" }); for (const [k, v] of list) files[k.slice(2)] = v;
      return json({ meta, messages: await this.get("messages", []), todos: await this.get("todos", []), memory: await this.get("memory", []), files });
    }
    if (p === "/events") {
      const after = +(url.searchParams.get("after") || 0); const out = [];
      for (const [, v] of await this.state.storage.list({ prefix: "ev:", start: "ev:" + String(after + 1).padStart(8, "0"), limit: 500 })) out.push(v);
      return json({ events: out, status: meta.status });
    }
    if (p === "/messages" && req.method === "POST") {
      const { text, model } = await req.json();
      if (meta.status === "running") return json({ error: "a turn is already running" }, 409);
      if (req.headers.get("x-github-token")) await this.put("token", req.headers.get("x-github-token"));
      meta.status = "running"; if (model) meta.model = model; await this.put("meta", meta);
      await this.event("user", { text });
      this.state.waitUntil(this.turn(text).catch(async (e) => { await this.event("error", { message: String(e.message || e) }); }).finally(async () => { const m = await this.get("meta"); m.status = "idle"; await this.put("meta", m); await this.event("idle", {}); }));
      return json({ ok: true }, 202);
    }
    if (p === "/commit" && req.method === "POST") { const b = await req.json(); return json({ result: await this.commitPush(b.message || "Atom Cloud changes", b.branch) }); }
    return json({ error: "not found" }, 404);
  }
  async webSocketMessage(ws, msg) { /* clients only listen; messages are sent over HTTP */ }

  // --- index (list of sessions), lives in the "__index__" object
  async indexOp(p, req) {
    const all = await this.get("sessions", {});
    if (p === "/index/list") return json({ sessions: Object.values(all).sort((a, b) => b.created - a.created) });
    const b = await req.json();
    if (p === "/index/put") all[b.id] = b; if (p === "/index/del") delete all[b.id];
    await this.put("sessions", all); return json({ ok: true });
  }

  // --- repository working copy: GitHub tree at the base commit + overlay of edits stored in the DO
  async baseTree() {
    const cached = await this.get("tree"); if (cached) return cached;
    const meta = await this.get("meta"); if (!meta.repo) return { files: [] };
    const tok = await this.get("token"); const { owner, name } = meta.repo;
    const sha = meta.repo.commit || (await gh(tok, `/repos/${owner}/${name}/commits/${encodeURIComponent(meta.repo.branch || meta.repo.base || "HEAD")}`)).sha;
    const t = await gh(tok, `/repos/${owner}/${name}/git/trees/${sha}?recursive=1`);
    const tree = { commit: sha, files: t.tree.filter((x) => x.type === "blob").map((x) => ({ path: x.path, sha: x.sha, size: x.size })) };
    await this.put("tree", tree); return tree;
  }
  async listPaths(prefix = "") {
    const tree = await this.baseTree(); const set = new Set(tree.files.map((f) => f.path));
    for (const [k, v] of await this.state.storage.list({ prefix: "f:" })) { if (v === null) set.delete(k.slice(2)); else set.add(k.slice(2)); }
    return [...set].filter((x) => x.startsWith(prefix.replace(/^\.?\//, ""))).sort();
  }
  async readFile(path) {
    path = path.replace(/^\.?\//, "");
    const ov = await this.state.storage.get("f:" + path); if (ov === null) throw new Error(`${path} was deleted`); if (typeof ov === "string") return ov;
    const tree = await this.baseTree(); const f = tree.files.find((x) => x.path === path); if (!f) throw new Error(`no such file: ${path}`);
    const cached = await this.get("blob:" + f.sha); if (cached != null) return cached;
    const meta = await this.get("meta"); const blob = await gh(await this.get("token"), `/repos/${meta.repo.owner}/${meta.repo.name}/git/blobs/${f.sha}`);
    const text = unb64(blob.content); if (text.length < 120_000) await this.put("blob:" + f.sha, text); return text;
  }
  async runTool(name, a) {
    switch (name) {
      case "list_files": { const l = await this.listPaths(a.prefix || ""); return l.slice(0, 1000).join("\n") + (l.length > 1000 ? `\n… ${l.length - 1000} more` : ""); }
      case "read_file": { const t = await this.readFile(a.path); return t.split("\n").map((l, i) => `${String(i + 1).padStart(5)}\t${l}`).join("\n").slice(0, 40000); }
      case "write_file": await this.put("f:" + a.path.replace(/^\.?\//, ""), a.content); await this.event("file", { path: a.path, op: "write" }); return `Wrote ${a.path} (${a.content.split("\n").length} lines)`;
      case "edit_file": {
        const t = await this.readFile(a.path); const n = t.split(a.old_string).length - 1;
        if (n !== 1) return `Error: old_string found ${n} times in ${a.path}; it must be unique`;
        await this.put("f:" + a.path.replace(/^\.?\//, ""), t.replace(a.old_string, a.new_string)); await this.event("file", { path: a.path, op: "edit" }); return `Edited ${a.path}`;
      }
      case "delete_file": await this.put("f:" + a.path.replace(/^\.?\//, ""), null); return `Deleted ${a.path}`;
      case "grep": {
        const re = new RegExp(a.pattern); const hits = []; const files = (await this.listPaths(a.prefix || "")).slice(0, 300);
        for (const f of files) { let t; try { t = await this.readFile(f); } catch { continue; } t.split("\n").forEach((l, i) => { if (re.test(l) && hits.length < 200) hits.push(`${f}:${i + 1}: ${l.slice(0, 200)}`); }); }
        return hits.join("\n") || "No matches.";
      }
      case "todo_write": await this.put("todos", a.todos || []); await this.event("todos", { todos: a.todos }); return (a.todos || []).map((t) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`).join("\n");
      case "git_commit_push": return this.commitPush(a.message, a.branch);
      case "open_pull_request": {
        const meta = await this.get("meta"); if (!meta.pushed) return "Error: push a branch first with git_commit_push";
        const pr = await gh(await this.get("token"), `/repos/${meta.repo.owner}/${meta.repo.name}/pulls`, { method: "POST", body: JSON.stringify({ title: a.title, body: a.body || "Opened by Atom Cloud.", head: meta.pushed.branch, base: a.base || meta.repo.base || meta.repo.defaultBranch || "main" }) });
        meta.pr = pr.html_url; await this.put("meta", meta); await this.event("pr", { url: pr.html_url }); return `Opened ${pr.html_url}`;
      }
      case "web_fetch": { const r = await fetch(a.url, { headers: { "user-agent": "atom-cloud" } }); return (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 20000); }
    }
    return `Error: unknown tool ${name}`;
  }
  async commitPush(message, branch) {
    const meta = await this.get("meta"); if (!meta.repo) return "Error: this session has no GitHub repository";
    const tok = await this.get("token"); const { owner, name } = meta.repo; const repo = `/repos/${owner}/${name}`;
    const overlay = await this.state.storage.list({ prefix: "f:" }); if (!overlay.size) return "Nothing to commit.";
    const target = branch || meta.pushed?.branch || (meta.repo.branch && meta.repo.branch !== meta.repo.defaultBranch ? meta.repo.branch : `atom/cloud-${meta.id}`);
    let parent; try { parent = (await gh(tok, `${repo}/git/ref/heads/${target}`)).object.sha; } catch { parent = (await this.baseTree()).commit; }
    const parentCommit = await gh(tok, `${repo}/git/commits/${parent}`);
    const entries = [];
    for (const [k, v] of overlay) entries.push(v === null ? { path: k.slice(2), mode: "100644", type: "blob", sha: null } : { path: k.slice(2), mode: "100644", type: "blob", sha: (await gh(tok, `${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: b64(v), encoding: "base64" }) })).sha });
    const tree = await gh(tok, `${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: parentCommit.tree.sha, tree: entries }) });
    const commit = await gh(tok, `${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [parent] }) });
    try { await gh(tok, `${repo}/git/refs/heads/${target}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) }); }
    catch { await gh(tok, `${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${target}`, sha: commit.sha }) }); }
    meta.pushed = { branch: target, commit: commit.sha, at: Date.now() }; await this.put("meta", meta);
    await this.event("pushed", { branch: target, commit: commit.sha, files: entries.length });
    return `Pushed ${entries.length} file(s) to ${owner}/${name}@${target} (${commit.sha.slice(0, 7)})`;
  }

  async turn(text) {
    const env = this.env; const meta = await this.get("meta"); const messages = await this.get("messages", []);
    messages.push({ role: "user", content: text });
    const memory = await this.get("memory", []);
    const sys = [
      "You are Atom, a coding agent now running in Atom Cloud on the user's Cloudflare account. You continue a session the user started on their computer.",
      meta.repo ? `Repository: ${meta.repo.owner}/${meta.repo.name}, branch ${meta.repo.branch || meta.repo.base}. Files the user had changed locally are already applied to your working copy.` : "No repository is attached.",
      "Tools work on the repository working copy. There is no shell here. When the work is done and the user wants it saved, call git_commit_push, and open_pull_request if asked. Keep replies short.",
      memory.length ? "Long-term memory about the user:\n" + memory.map((m) => "- " + m).join("\n") : "",
    ].filter(Boolean).join("\n\n");
    for (let step = 0; step < 30; step++) {
      const out = await env.AI.run(meta.model || MODEL_DEFAULT, { messages: [{ role: "system", content: sys }, ...messages], tools: TOOLS.map((t) => ({ type: "function", function: t })), max_tokens: 4096 });
      const msg = out.choices?.[0]?.message || { content: out.response || "", tool_calls: out.tool_calls };
      const calls = (msg.tool_calls || []).map((c, i) => ({ id: c.id || `c${step}_${i}`, name: c.function?.name || c.name, args: c.function?.arguments ?? c.arguments ?? "{}" }));
      const content = typeof msg.content === "string" ? msg.content : "";
      const am = { role: "assistant", content };
      if (calls.length) am.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args) } }));
      messages.push(am); if (content) await this.event("assistant", { text: content });
      await this.put("messages", messages);
      if (!calls.length) break;
      for (const c of calls) {
        let args = {}; try { args = typeof c.args === "string" ? JSON.parse(c.args || "{}") : c.args; } catch {}
        await this.event("tool", { name: c.name, args });
        let result; try { result = await this.runTool(c.name, args); } catch (e) { result = "Error: " + e.message; }
        await this.event("tool_result", { name: c.name, result: String(result).slice(0, 2000) });
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: String(result).slice(0, 40000) });
      }
      await this.put("messages", messages);
    }
  }
}

const UI = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atom Cloud</title>
<style>body{font:15px/1.5 ui-sans-serif,system-ui;max-width:900px;margin:24px auto;padding:0 16px;background:#faf9f5;color:#1f1e1d}button,input,textarea,select{font:inherit}
#log{background:#1f1e1d;color:#e8e6dc;padding:12px;border-radius:8px;height:55vh;overflow:auto;white-space:pre-wrap;font:13px/1.45 ui-monospace,Menlo,monospace}
.t{color:#7fd1e8}.e{color:#ff8a80}.u{color:#ffd479}.r{color:#9e9e9e}.p{color:#a5d6a7}textarea{width:100%;height:70px}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}a{color:#c15f3c}</style></head><body>
<h2>✻ Atom Cloud</h2><div id="auth"></div><div id="app" hidden>
<div class="row"><select id="sess"></select><button onclick="load()">Open</button><span id="who"></span> <a href="/auth/logout">sign out</a></div>
<div id="meta" class="r"></div><div id="log"></div>
<textarea id="msg" placeholder="Continue the session…"></textarea><div class="row"><button onclick="send()">Send</button><button onclick="commit()">Commit &amp; push</button><span id="st"></span></div></div>
<script>
let cur=null, after=0, timer=null; const $=(i)=>document.getElementById(i);
async function api(p,o={}){const r=await fetch(p,{...o,headers:{'content-type':'application/json'}});if(r.status===401)throw 401;return r.json();}
function line(cls,t){const d=document.createElement('div');d.className=cls;d.textContent=t;$('log').appendChild(d);$('log').scrollTop=1e9;}
function show(e){const d=e.data||{};if(e.type==='user')line('u','> '+d.text);else if(e.type==='assistant')line('','⏺ '+d.text);else if(e.type==='tool')line('t','⏺ '+d.name+'('+JSON.stringify(d.args).slice(0,160)+')');else if(e.type==='tool_result')line('r','  ⎿ '+String(d.result).split('\\n').slice(0,4).join('\\n    '));else if(e.type==='pushed')line('p','⎇ pushed '+d.branch+' '+d.commit.slice(0,7));else if(e.type==='pr')line('p','PR '+d.url);else if(e.type==='error')line('e','error: '+d.message);else if(e.type==='idle')$('st').textContent='idle';}
async function poll(){if(!cur)return;const r=await api('/api/sessions/'+cur+'/events?after='+after);for(const e of r.events){after=e.seq;show(e);}$('st').textContent=r.status;}
async function load(){cur=$('sess').value;after=0;$('log').textContent='';const s=await api('/api/sessions/'+cur);$('meta').textContent=(s.meta.repo?s.meta.repo.owner+'/'+s.meta.repo.name+' @ '+(s.meta.repo.branch||''):'')+' · '+s.messages.length+' messages · '+s.meta.model;
 for(const m of s.messages){if(m.role==='user'&&typeof m.content==='string')line('u','> '+m.content.slice(0,500));else if(m.role==='assistant'&&m.content)line('','⏺ '+m.content.slice(0,2000));}
 const ev=await api('/api/sessions/'+cur+'/events?after=0');after=ev.events.length?ev.events[ev.events.length-1].seq:0;clearInterval(timer);timer=setInterval(poll,1500);}
async function send(){const t=$('msg').value.trim();if(!t||!cur)return;$('msg').value='';await api('/api/sessions/'+cur+'/messages',{method:'POST',body:JSON.stringify({text:t})});poll();}
async function commit(){if(!cur)return;const m=prompt('Commit message','Changes from Atom Cloud');if(!m)return;const r=await api('/api/sessions/'+cur+'/commit',{method:'POST',body:JSON.stringify({message:m})});line('p',r.result);}
async function start(){try{const me=await api('/api/me');$('who').textContent='signed in as '+me.login;$('app').hidden=false;$('auth').innerHTML='';const l=await api('/api/sessions');$('sess').innerHTML=l.sessions.map(s=>'<option value="'+s.id+'">'+(s.title||s.id).replace(/</g,'&lt;')+' · '+s.repo+'</option>').join('');if(l.sessions.length)load();}
 catch(e){const h=await (await fetch('/health')).json();$('auth').innerHTML='<p>Sign in with GitHub as <b>'+(h.user||'?')+'</b>.</p>'+(h.deviceFlow?'<button onclick="device()">Sign in with GitHub</button> ':'')+'<details'+(h.deviceFlow?'':' open')+'><summary>or paste a GitHub token</summary><input id="tok" type="password" size="50"> <button onclick="tok()">Use token</button></details><p id="dv"></p>';}}
async function tok(){const r=await fetch('/auth/token',{method:'POST',body:JSON.stringify({token:$('tok').value})});if(r.ok)start();else $('dv').textContent=(await r.json()).error;}
async function device(){const d=await (await fetch('/auth/device',{method:'POST'})).json();$('dv').innerHTML='Open <a target=_blank href="'+d.verification_uri+'">'+d.verification_uri+'</a> and enter <b>'+d.user_code+'</b>';
 const iv=setInterval(async()=>{const r=await fetch('/auth/device/poll',{method:'POST',body:JSON.stringify({device_code:d.device_code})});if(r.status===200){clearInterval(iv);start();}else if(r.status===403){clearInterval(iv);$('dv').textContent=(await r.json()).error;}},(d.interval||5)*1000+500);}
start();
</script></body></html>`;
