import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG_DIR, Credentials, ensureDir } from "./config.js";
import { chat } from "./provider.js";
import { classify, cosine, embed } from "./workersai.js";

/** Long-term (cross-session) memory: facts and preferences stored locally in ~/.config/atom/memory.json,
 *  embedded with Workers AI bge-m3, gated by the Clef-flash classifier, optionally synced to D1 through the gateway. */
export interface Memory { id: string; scope: string; kind: string; text: string; vec: number[] | null; created: number; deleted?: boolean }
export interface Route { remember: number; recall: number; intent: string; intents: Record<string, number> }
export const INTENTS = { code: "write, change, fix, or run code in the project", explain: "explain or find something in the codebase", web: "needs current information from the internet (docs, versions, news, prices)", memory: "tells Atom to remember or forget something, or asks what it remembers", chat: "small talk, thanks, or a statement" };

export class LongTermMemory {
  file = path.join(CONFIG_DIR, "memory.json");
  mems: Memory[] = [];
  constructor(public creds: Credentials, public scope: string, public opts: { extractModel?: string; sync?: boolean; threshold?: number } = {}) { this.load(); }
  load() { try { this.mems = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.mems = []; } }
  save() { ensureDir(CONFIG_DIR); fs.writeFileSync(this.file, JSON.stringify(this.mems), { mode: 0o600 }); }
  /** Memories visible here: global + this project's scope. */
  visible() { return this.mems.filter((m) => !m.deleted && (m.scope === "global" || m.scope === this.scope)); }

  async add(text: string, kind = "fact", scope = kind === "project" ? this.scope : "global"): Promise<Memory | null> {
    text = text.trim(); if (!text) return null;
    const [vec] = await embed(this.creds, [text]);
    const dup = this.visible().find((m) => m.vec && cosine(m.vec, vec) > 0.9);
    if (dup) { dup.text = text; dup.vec = vec; this.save(); return dup; }
    const m: Memory = { id: crypto.randomBytes(4).toString("hex"), scope, kind, text, vec, created: Date.now() };
    this.mems.push(m); this.save(); this.sync().catch(() => {}); return m;
  }
  forget(idOrText: string): number {
    let n = 0; for (const m of this.visible()) if (m.id === idOrText || (idOrText.length > 3 && m.text.toLowerCase().includes(idOrText.toLowerCase()))) { m.deleted = true; n++; }
    this.save(); this.sync().catch(() => {}); return n;
  }
  clear() { for (const m of this.visible()) m.deleted = true; this.save(); this.sync().catch(() => {}); }
  async search(q: string, k = 5, min = this.opts.threshold ?? 0.4): Promise<(Memory & { score: number })[]> {
    const vis = this.visible().filter((m) => m.vec); if (!vis.length) return [];
    const [qv] = await embed(this.creds, [q]);
    return vis.map((m) => ({ ...m, score: cosine(qv, m.vec!) })).filter((m) => m.score >= min).sort((a, b) => b.score - a.score).slice(0, k);
  }
  /** Clef-flash routing: should this prompt be remembered / does it need recall / what is the intent. */
  async route(prompt: string): Promise<Route> {
    const a = await classify(this.creds, `User message to a coding assistant:\n${prompt.slice(0, 4000)}`, {
      remember: { type: "noul", instructions: "Does this message state a durable fact, preference, convention, or personal detail (about the user or their project) that would still be useful in future, separate sessions? Ordinary one-off task requests are not." },
      recall: { type: "noul", instructions: "Would knowing the user's earlier stated preferences, past decisions, or personal facts help answer this message well?" },
      intent: { type: "choice", instructions: "What is the user asking for?", criteria: INTENTS },
    });
    return { remember: a.remember?.noul ?? 0, recall: a.recall?.noul ?? 0, intent: a.intent?.choice || "code", intents: a.intent?.probabilities || {} };
  }
  /** Ask a small LLM to extract atomic facts worth keeping. */
  async extract(prompt: string, reply: string): Promise<{ text: string; kind: string }[]> {
    const r = await chat(this.creds, this.opts.extractModel || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", [
      { role: "system", content: 'Extract durable facts worth remembering across future sessions from the USER message (preferences, conventions, personal details, project decisions). Ignore one-off task details. Output ONLY a JSON array like [{"text":"User prefers pnpm over npm","kind":"preference"}] where kind is one of preference|user|project. Write each text as a standalone third-person sentence. Output [] if nothing.' },
      { role: "user", content: `USER: ${prompt.slice(0, 4000)}\n\nASSISTANT (context only): ${reply.slice(0, 1500)}` },
    ], []);
    const m = r.content.match(/\[[\s\S]*\]/); if (!m) return [];
    try { return (JSON.parse(m[0]) as any[]).filter((x) => x && typeof x.text === "string").slice(0, 5); } catch { return []; }
  }
  /** Two-way merge with the gateway's D1 table (gateway credentials + settings.memory.sync only). */
  async sync(): Promise<string> {
    const c = this.creds; if (!this.opts.sync || c.kind !== "gateway") return "sync off (needs gateway login and settings.memory.sync=true)";
    const url = c.url.replace(/\/$/, "") + "/v1/memory", h = { authorization: `Bearer ${c.key}`, "content-type": "application/json" };
    const r: any = await (await fetch(url, { headers: h })).json();
    const byId = new Map(this.mems.map((m) => [m.id, m])); let pulled = 0;
    for (const rm of r.memories || []) { const l = byId.get(rm.id); if (!l) { this.mems.push(rm); pulled++; } else if (rm.deleted && !l.deleted) l.deleted = true; }
    this.save();
    await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ memories: this.mems }) });
    return `synced: pulled ${pulled}, pushed ${this.mems.length}`;
  }
}
