import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { Credentials, saveCredentials } from "./config.js";
import { verify } from "./provider.js";

const API = "https://api.cloudflare.com/client/v4";
const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

export async function accountsFor(token: string): Promise<{ id: string; name: string }[]> {
  const r = await fetch(`${API}/accounts?per_page=50`, { headers: { authorization: `Bearer ${token}` } });
  const j: any = await r.json(); if (!j.success) throw new Error("Token rejected: " + JSON.stringify(j.errors)); return j.result.map((a: any) => ({ id: a.id, name: a.name }));
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
  try { execSync(`${cmd} "${url}"`, { stdio: "ignore" }); } catch {}
}

/** Prefilled "create token" link: Workers AI Read + Edit, Account Settings Read (for auto-detecting the account). */
export const TOKEN_TEMPLATE = `${TOKEN_PAGE}?permissionGroupKeys=${encodeURIComponent(JSON.stringify([{ key: "workers_ai", type: "read" }, { key: "workers_ai", type: "edit" }, { key: "account_settings", type: "read" }]))}&accountId=*&zoneId=all&name=${encodeURIComponent("Atom CLI (Workers AI)")}`;

/** Check that a token is live and can actually run Workers AI on the account. */
export async function checkToken(token: string, accountId: string): Promise<{ ok: boolean; why?: string }> {
  const h = { authorization: `Bearer ${token}` };
  const v1: any = await (await fetch(`${API}/user/tokens/verify`, { headers: h })).json().catch(() => ({}));
  const v2: any = v1.success ? v1 : await (await fetch(`${API}/accounts/${accountId}/tokens/verify`, { headers: h })).json().catch(() => ({}));
  if (!v2.success) return { ok: false, why: "Cloudflare rejected the token (invalid, expired or revoked)." };
  const r = await fetch(`${API}/accounts/${accountId}/ai/run/@cf/baai/bge-small-en-v1.5`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify({ text: ["atom login check"] }) });
  if (r.ok) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, why: `The token is valid but has no Workers AI permission on account ${accountId}. Create one with "Workers AI: Read" and "Workers AI: Edit".` };
  return { ok: false, why: `Workers AI check failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}` };
}

/** API-token login (the default, works for any Cloudflare account, including the free plan). */
export async function loginApiToken(ask: (q: string) => Promise<string>, token?: string, accountId?: string): Promise<Credentials> {
  if (!token) {
    console.log([
      "Atom runs on Workers AI in YOUR Cloudflare account (the free plan includes 10,000 neurons/day).",
      "1. Open this link (pre-filled with Workers AI Read + Edit and Account Settings Read):",
      `   ${TOKEN_TEMPLATE}`,
      "2. Click \"Continue to summary\" → \"Create Token\", then copy the token.",
      "   (Or use the \"Workers AI\" template on " + TOKEN_PAGE + ")",
      "Prefer browser login? Run `atom login --wrangler` instead.",
    ].join("\n"));
    openBrowser(TOKEN_TEMPLATE);
    token = (await ask("Paste API token: ")).trim();
  }
  if (!token) throw new Error("No token given.");
  if (!accountId) {
    let rejected = false;
    const accts = await accountsFor(token).catch((e) => { rejected = /rejected|Invalid/i.test(String(e.message)); return []; });
    if (rejected) { const v: any = await (await fetch(`${API}/user/tokens/verify`, { headers: { authorization: `Bearer ${token}` } })).json().catch(() => ({})); if (!v.success) throw new Error(`Cloudflare rejected this token (invalid or revoked). Create one here: ${TOKEN_TEMPLATE}`); }
    if (accts.length === 1) { accountId = accts[0].id; console.log(`Account: ${accts[0].name} (${accountId})`); }
    else if (accts.length > 1) { accts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} (${a.id})`)); accountId = accts[+(await ask("Account number: ")) - 1]?.id; }
    else accountId = (await ask("Account ID (dash.cloudflare.com → Workers AI → the ID in the URL or the right sidebar): ")).trim();
  }
  if (!accountId) throw new Error("No account selected.");
  const chk = await checkToken(token, accountId);
  if (!chk.ok) throw new Error(`${chk.why}\nCreate a correctly-scoped token here: ${TOKEN_TEMPLATE}`);
  const c: Credentials = { kind: "api_token", accountId, apiToken: token };
  console.log(await verify(c)); saveCredentials(c); return c;
}

/** OAuth 2.0 Authorization Code + PKCE against Cloudflare's OAuth endpoints, with a localhost callback.
 *  Needs an OAuth client registered with Cloudflare: set ATOM_OAUTH_CLIENT_ID. */
export async function loginOAuth(): Promise<Credentials> {
  const clientId = process.env.ATOM_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error("OAuth needs ATOM_OAUTH_CLIENT_ID (a Cloudflare OAuth client). Use `atom login --wrangler` or an API token instead.");
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");
  const port = 8976, redirect = `http://localhost:${port}/oauth/callback`;
  const scopes = "account:read user:read ai:write offline_access";
  const url = `https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(scopes)}&state=${state}&code_challenge=${challenge}&code_challenge_method=S256`;
  const code: string = await new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url!, redirect);
      if (u.pathname !== "/oauth/callback") { res.end(); return; }
      if (u.searchParams.get("state") !== state) { res.end("State mismatch"); reject(new Error("state mismatch")); srv.close(); return; }
      res.end("Atom is logged in. You can close this tab."); srv.close();
      const c = u.searchParams.get("code"); c ? resolve(c) : reject(new Error(u.searchParams.get("error") || "no code"));
    }).listen(port);
    console.log(`Opening browser to log in with Cloudflare...\n${url}`); openBrowser(url);
  });
  const r = await fetch("https://dash.cloudflare.com/oauth2/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier }) });
  const t: any = await r.json(); if (!t.access_token) throw new Error("Token exchange failed: " + JSON.stringify(t));
  const accts = await accountsFor(t.access_token);
  const c: Credentials = { kind: "oauth", accountId: accts[0].id, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (t.expires_in || 3600) * 1000 };
  saveCredentials(c); return c;
}

/** Reuse the user's own `wrangler login` (OAuth) session from this machine. */
export function wranglerConfigPath(): string | null {
  const cands = [path.join(os.homedir(), ".config", ".wrangler", "config", "default.toml"), path.join(os.homedir(), ".wrangler", "config", "default.toml"), path.join(os.homedir(), "Library", "Preferences", ".wrangler", "config", "default.toml")];
  return cands.find((p) => fs.existsSync(p)) || null;
}
export function readWranglerToken(): { token: string; expires?: number } | null {
  const p = wranglerConfigPath(); if (!p) return null;
  const t = fs.readFileSync(p, "utf8");
  const tok = /oauth_token\s*=\s*"([^"]+)"/.exec(t)?.[1]; const exp = /expiration_time\s*=\s*"([^"]+)"/.exec(t)?.[1];
  return tok ? { token: tok, expires: exp ? Date.parse(exp) : undefined } : null;
}
export async function loginWrangler(): Promise<Credentials> {
  let w = readWranglerToken();
  if (!w || (w.expires && w.expires < Date.now())) {
    console.log("Running `npx wrangler login` (browser OAuth with your Cloudflare account)...");
    execSync("npx -y wrangler login", { stdio: "inherit" }); w = readWranglerToken();
  }
  if (!w) throw new Error("No wrangler OAuth token found after login.");
  const accts = await accountsFor(w.token);
  const c: Credentials = { kind: "oauth", accountId: accts[0].id, accessToken: w.token, expiresAt: w.expires, refreshToken: "wrangler" };
  console.log(await verify(c)); saveCredentials(c); return c;
}
/** Refresh a wrangler-backed OAuth credential by letting wrangler refresh its own token. */
export function refreshIfNeeded(c: Credentials): Credentials {
  if (c.kind !== "oauth" || !c.expiresAt || c.expiresAt > Date.now() + 60000 || c.refreshToken !== "wrangler") return c;
  try { execSync("npx -y wrangler whoami", { stdio: "ignore" }); } catch {}
  const w = readWranglerToken(); if (!w) return c;
  const n: Credentials = { ...c, accessToken: w.token, expiresAt: w.expires }; saveCredentials(n); return n;
}

export async function loginGateway(url: string, key: string): Promise<Credentials> {
  const c: Credentials = { kind: "gateway", url, key }; console.log(await verify(c)); saveCredentials(c); return c;
}
