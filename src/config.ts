import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = process.env.ATOM_CONFIG_DIR || path.join(os.homedir(), ".config", "atom");
export const CRED_FILE = path.join(CONFIG_DIR, "credentials.json");
export const SETTINGS_FILE = path.join(CONFIG_DIR, "settings.json");
export const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

export type Credentials =
  | { kind: "api_token"; accountId: string; apiToken: string }
  | { kind: "oauth"; accountId: string; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { kind: "gateway"; url: string; key: string };

export const MODELS: Record<string, string> = {
  "gpt-oss-120b": "@cf/openai/gpt-oss-120b",
  "gpt-oss-20b": "@cf/openai/gpt-oss-20b",
  "llama-3.3-70b": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "kimi-k2.7-code": "@cf/moonshotai/kimi-k2.7-code",
  "glm-5.3": "@cf/zai-org/glm-5.3",
  "deepseek-v4-flash": "@cf/deepseek-ai/deepseek-v4-flash-0731",
  "qwen3-30b": "@cf/qwen/qwen3-30b-a3b-fp8",
  "qwen-coder": "@cf/qwen/qwen2.5-coder-32b-instruct",
  "llama-4-scout": "@cf/meta/llama-4-scout-17b-16e-instruct",
};
export const DEFAULT_MODEL = MODELS["gpt-oss-120b"];
export function resolveModel(m: string): string { return MODELS[m] || m; }
/** Resolve a user-typed model name: exact alias, full @cf id, unique prefix, or unique substring of alias/id. */
export function matchModel(q: string): { model?: string; candidates: string[] } {
  q = q.trim(); if (!q) return { candidates: [] };
  if (MODELS[q]) return { model: MODELS[q], candidates: [q] };
  if (q.startsWith("@cf/") || q.startsWith("@hf/")) return { model: q, candidates: [q] };
  const lq = q.toLowerCase(); const keys = Object.keys(MODELS);
  for (const test of [(k: string) => k.toLowerCase().startsWith(lq), (k: string) => k.toLowerCase().includes(lq) || MODELS[k].toLowerCase().includes(lq), (k: string) => { let i = 0; for (const ch of k.toLowerCase()) if (ch === lq[i]) i++; return i === lq.length; }]) {
    const hit = keys.filter(test); if (hit.length === 1) return { model: MODELS[hit[0]], candidates: hit }; if (hit.length > 1) return { candidates: hit };
  }
  return { candidates: [] };
}
/** Persist the default model in ~/.config/atom/settings.json. */
export function saveUserModel(model: string) {
  ensureDir(CONFIG_DIR); let j: any = {}; try { j = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch {}
  j.model = model; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(j, null, 2));
}

function ensureDir(d: string) { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); }

export function loadCredentials(): Credentials | null {
  // Environment wins (useful for CI): ATOM_GATEWAY_URL+ATOM_GATEWAY_KEY or CLOUDFLARE_ACCOUNT_ID+CLOUDFLARE_API_TOKEN
  const e = process.env;
  if (e.ATOM_GATEWAY_URL && e.ATOM_GATEWAY_KEY) return { kind: "gateway", url: e.ATOM_GATEWAY_URL, key: e.ATOM_GATEWAY_KEY };
  if (e.ATOM_API_TOKEN && e.CLOUDFLARE_ACCOUNT_ID) return { kind: "api_token", accountId: e.CLOUDFLARE_ACCOUNT_ID, apiToken: e.ATOM_API_TOKEN };
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { return null; }
}
export function saveCredentials(c: Credentials) {
  ensureDir(CONFIG_DIR);
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}
export function clearCredentials() { try { fs.unlinkSync(CRED_FILE); } catch {} }

export interface Settings {
  model?: string;
  permissionMode?: "ask" | "auto" | "plan";
  autoCompact?: boolean; autoCompactTokens?: number;
  allow?: string[]; // e.g. ["bash:npm test", "write_file", "edit_file"]
  hooks?: Record<string, { matcher?: string; command: string }[]>;
  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: "stdio" | "http" | "sse"; headers?: Record<string, string>; disabled?: boolean }>;
  plugins?: string[];
  memory?: { enabled?: boolean; route?: boolean; sync?: boolean; threshold?: number; rememberThreshold?: number; extractModel?: string };
  index?: { enabled?: boolean };
  autoUpdate?: boolean;
}
function readJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } }
/** Merge user settings (~/.config/atom/settings.json) with project settings (.atom/settings.json). */
export function loadSettings(cwd: string): Settings {
  const u = readJson(SETTINGS_FILE), p = readJson(path.join(cwd, ".atom", "settings.json"));
  return {
    ...u, ...p,
    allow: [...(u.allow || []), ...(p.allow || [])],
    hooks: { ...(u.hooks || {}), ...(p.hooks || {}) },
    mcpServers: { ...(u.mcpServers || {}), ...(p.mcpServers || {}) },
    plugins: [...(u.plugins || []), ...(p.plugins || [])],
    memory: { ...(u.memory || {}), ...(p.memory || {}) },
  };
}
export function saveProjectAllow(cwd: string, rule: string) {
  const f = path.join(cwd, ".atom", "settings.json");
  const s = readJson(f); s.allow = Array.from(new Set([...(s.allow || []), rule]));
  ensureDir(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(s, null, 2));
}
export { ensureDir };
