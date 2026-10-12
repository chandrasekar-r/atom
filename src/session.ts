import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR, ensureDir } from "./config.js";
import { Msg, Usage } from "./provider.js";
import { Snapshot } from "./checkpoint.js";

export interface Session { id: string; cwd: string; model: string; created: number; updated: number; title: string; messages: Msg[]; usage: Usage; turn: number; snapshots: Snapshot[]; turnIndex: Record<number, number> }
export function newSession(cwd: string, model: string): Session {
  const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);
  return { id, cwd, model, created: Date.now(), updated: Date.now(), title: "", messages: [], usage: { prompt: 0, completion: 0, neurons: 0 }, turn: 0, snapshots: [], turnIndex: {} };
}
export function saveSession(s: Session) { recordHistory(s); ensureDir(SESSIONS_DIR); s.updated = Date.now(); fs.writeFileSync(path.join(SESSIONS_DIR, s.id + ".json"), JSON.stringify(s)); }
export function listSessions(cwd?: string): Session[] {
  try {
    return fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8")); } catch { return null; } })
      .filter((s): s is Session => !!s && (!cwd || s.cwd === cwd)).sort((a, b) => b.updated - a.updated);
  } catch { return []; }
}
export function loadSession(id: string): Session | null { const all = listSessions(); return all.find((s) => s.id === id || s.id.startsWith(id)) || null; }

// ---- Conversation history graph.
// Every message ever sent is kept in `history.entries` (append-only). Each entry points at the entry it
// followed (`after`, -1 for the first message). `history.head` is the last entry of the conversation
// currently shown; editing an earlier prompt simply moves `head` back and new messages fork from there.
export interface HistoryEntry { after: number; msg: Msg; at: number }
export interface History { entries: HistoryEntry[]; head: number }
type WithHistory = Session & { history?: History };
const same = (a: Msg, b: Msg) => JSON.stringify(a) === JSON.stringify(b);
function chainOf(h: History, end: number): number[] { const ids: number[] = []; for (let i = end; i >= 0; i = h.entries[i].after) ids.push(i); return ids.reverse(); }

/** Record s.messages into the graph, reusing existing entries for the shared prefix. */
export function recordHistory(s: WithHistory): History {
  const h = (s.history ||= { entries: [], head: -1 });
  let cur = -1;
  for (const m of s.messages) {
    let found = -1;
    for (let i = 0; i < h.entries.length; i++) if (h.entries[i].after === cur && same(h.entries[i].msg, m)) { found = i; break; }
    if (found < 0) { h.entries.push({ after: cur, msg: m, at: Date.now() }); found = h.entries.length - 1; }
    cur = found;
  }
  h.head = cur; return h;
}
/** Make the conversation end just before entry `id` and return that entry's text (to re-edit it). */
export function rewindTo(s: WithHistory, id: number): string {
  const h = recordHistory(s); const e = h.entries[id]; if (!e) return "";
  h.head = e.after; s.messages = h.head < 0 ? [] : chainOf(h, h.head).map((i) => h.entries[i].msg);
  s.turnIndex = {}; let turn = 0; s.messages.forEach((m, i) => { if (m.role === "user") s.turnIndex[++turn] = i; }); s.turn = turn;
  return typeof e.msg.content === "string" ? e.msg.content : "";
}
/** User prompts as an indented outline; alternative versions of a prompt are indented one level. */
export function historyOutline(s: WithHistory): { id: number; label: string; depth: number; active: boolean }[] {
  const h = recordHistory(s); const onPath = new Set(h.head < 0 ? [] : chainOf(h, h.head));
  const rows: { id: number; label: string; depth: number; active: boolean }[] = [];
  const walk = (parent: number, depth: number) => {
    const kids = h.entries.map((e, i) => ({ e, i })).filter((x) => x.e.after === parent);
    const prompts = kids.filter((k) => k.e.msg.role === "user").length;
    for (const { e, i } of kids) {
      let d = depth;
      if (e.msg.role === "user") { if (prompts > 1) d = depth + 1; rows.push({ id: i, depth: d, active: onPath.has(i), label: (typeof e.msg.content === "string" ? e.msg.content : "[message with image]").replace(/\s+/g, " ").slice(0, 70) }); }
      walk(i, d);
    }
  };
  walk(-1, 0); return rows;
}
