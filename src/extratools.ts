import path from "node:path";
import { Tool } from "./tools.js";
import { LongTermMemory } from "./ltm.js";
import { RepoIndex } from "./repoindex.js";
import { repoMap } from "./symbols.js";

export function memoryTools(ltm: LongTermMemory): Tool[] {
  return [
    { name: "memory_save", readOnly: true,
      description: "Save a durable fact or preference to long-term memory (persists across sessions). Use when the user says 'remember…' or states a lasting preference/convention. kind: preference | user | project.",
      parameters: { type: "object", properties: { text: { type: "string", description: "standalone sentence" }, kind: { type: "string", enum: ["preference", "user", "project"] } }, required: ["text"] },
      async run(a) { const m = await ltm.add(a.text, a.kind || "preference"); return m ? `Saved memory ${m.id}: ${m.text}` : "Nothing saved."; } },
    { name: "memory_search", readOnly: true,
      description: "Search long-term memory (facts and preferences from earlier sessions) by meaning.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      async run(a) { const r = await ltm.search(a.query, 8, 0.3); return r.length ? r.map((m) => `[${m.id}] (${m.score.toFixed(2)}) ${m.text}`).join("\n") : "No matching memories."; } },
    { name: "memory_forget", readOnly: false,
      description: "Delete long-term memories by id or by matching text.",
      parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
      preview: (a) => `forget memories matching: ${a.match}`,
      async run(a) { return `Forgot ${ltm.forget(a.match)} memories.`; } },
  ];
}
export function indexTools(idx: RepoIndex, notify?: (s: string) => void): Tool[] {
  return [
    { name: "semantic_search", readOnly: true,
      description: "Search this repository by meaning (embedding index of all files, respects .gitignore). Use for 'where is X handled / how does Y work' questions when you don't know exact identifiers; use grep for exact strings. Index updates incrementally on each call.",
      parameters: { type: "object", properties: { query: { type: "string" }, k: { type: "number" } }, required: ["query"] },
      async run(a) {
        const u = await idx.update(); if (u.chunks) notify?.(`index: +${u.added} ~${u.changed} -${u.removed} files (${u.chunks} chunks embedded)`);
        const hits = await idx.search(a.query, Math.min(15, a.k || 6));
        return hits.map((h) => `${h.file}:${h.start}-${h.end} (score ${h.score.toFixed(3)})\n${h.snippet.split("\n").slice(0, 25).map((l, i) => `${String(h.start + i).padStart(5)}\t${l}`).join("\n")}`).join("\n\n") || "No results.";
      } },
    { name: "repo_map", readOnly: true,
      description: "Show a compact map of the repository: files with their top-level functions, classes and types (line numbers). Optional path prefix to narrow.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async run(a, ctx) { const m = repoMap(ctx.cwd, 14000); return a.path ? m.split(/\n(?=\S)/).filter((b) => b.startsWith(a.path.replace(/^\.\//, ""))).join("\n") || "(nothing under that path)" : m; } },
  ];
}
