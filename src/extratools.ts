import path from "node:path";
import { Tool } from "./tools.js";
import { LongTermMemory } from "./ltm.js";
import { RepoIndex } from "./repoindex.js";
import { repoMap } from "./symbols.js";
import { CodeGraph } from "./codegraph.js";
import { hybridSearch } from "./hybrid.js";

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
export function indexTools(idx: RepoIndex, notify?: (s: string) => void, graph?: CodeGraph): Tool[] {
  const g = graph || new CodeGraph(idx.root);
  const fresh = async () => { const u = await idx.update(); if (u.chunks) notify?.(`index: +${u.added} ~${u.changed} -${u.removed} files (${u.chunks} chunks embedded)`); const r = await g.update().catch(() => null); if (r?.parsed) notify?.(`graph: ${r.parsed} files parsed`); };
  const gfresh = async () => { await g.update().catch(() => null); };
  const one = (q: string) => { const ids = g.resolveNode(q); return ids; };
  const fmt = (ids: string[], cap = 60) => ids.slice(0, cap).map((x) => "  " + g.label(x)).join("\n") + (ids.length > cap ? `\n  … ${ids.length - cap} more` : "");
  return [
    { name: "semantic_search", readOnly: true,
      description: "Find code by meaning (hybrid: embedding search seeds, expanded along the code graph — callers, callees, inheritance — then reranked). Use first for 'where/how is X done' questions; use grep for exact strings. Index and graph update incrementally on each call.",
      parameters: { type: "object", properties: { query: { type: "string" }, k: { type: "number" }, mode: { type: "string", enum: ["hybrid", "semantic"] } }, required: ["query"] },
      async run(a) {
        await fresh(); const k = Math.min(15, a.k || 6);
        const hits = a.mode === "semantic" ? (await idx.search(a.query, k)).map((h) => ({ ...h, why: "semantic" })) : await hybridSearch(idx.creds, idx, g, a.query, k);
        return hits.map((h) => `${h.file}:${h.start}-${h.end} (${h.why})\n${h.snippet.split("\n").slice(0, 25).map((l, i) => `${String(h.start + i).padStart(5)}\t${l}`).join("\n")}`).join("\n\n") || "No results.";
      } },
    { name: "find_symbol", readOnly: true,
      description: "Locate definitions of a function/class/type/method by name (exact, case-insensitive, or substring; 'Class.method' works). Returns file:line and kind.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      async run(a) { await gfresh(); const r = g.findSymbol(a.name, 25); return r.length ? r.map((d) => `${d.file}:${d.line}-${d.end} ${d.parent ? d.parent + "." : ""}${d.name} (${d.kind})`).join("\n") : `No symbol matching ${a.name}.`; } },
    { name: "find_callers", readOnly: true,
      description: "Who calls this symbol? (code graph; name or file#Name)",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      async run(a) { await gfresh(); const ids = one(a.symbol); if (!ids.length) return `No symbol ${a.symbol}.`; return ids.map((id) => `${g.label(id)} is called by:\n${fmt(g.callersOf(id)) || "  (no callers found)"}`).join("\n\n"); } },
    { name: "find_callees", readOnly: true,
      description: "What does this symbol call? (code graph; name or file#Name)",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
      async run(a) { await gfresh(); const ids = one(a.symbol); if (!ids.length) return `No symbol ${a.symbol}.`; return ids.map((id) => `${g.label(id)} calls:\n${fmt(g.calleesOf(id)) || "  (nothing resolved in this repo)"}`).join("\n\n"); } },
    { name: "impact_analysis", readOnly: true,
      description: "Before changing a symbol or file: list everything that transitively depends on it (callers, subclasses, type references, importers), with depth. Use to scope refactors and find tests to run.",
      parameters: { type: "object", properties: { target: { type: "string", description: "symbol name, file#Name, or file path" }, depth: { type: "number" } }, required: ["target"] },
      async run(a) {
        await gfresh(); const ids = one(a.target); if (!ids.length) return `No symbol or file ${a.target}.`;
        return ids.slice(0, 3).map((id) => { const r = g.impact(id, Math.min(6, a.depth || 3)); const files = new Set(r.map((x) => x.id.split("#")[0]));
          return `Impact of ${g.label(id)}: ${r.length} dependents in ${files.size} files\n` + r.slice(0, 80).map((x) => `  [d${x.depth} ${x.via}] ${g.label(x.id)}`).join("\n"); }).join("\n\n");
      } },
    { name: "graph_neighborhood", readOnly: true,
      description: "Show the code-graph neighbourhood of a symbol or file (imports, calls, defines, inherits, references) up to a depth.",
      parameters: { type: "object", properties: { node: { type: "string" }, depth: { type: "number" } }, required: ["node"] },
      async run(a) { await gfresh(); const id = one(a.node)[0]; if (!id) return `No node ${a.node}.`; const n = g.neighborhood(id, Math.min(3, a.depth || 1), 80); return `${g.label(id)}\n` + n.edges.map((e) => `  ${e.from.split("#").pop()} -${e.edge}-> ${e.to.split("#").pop()}`).join("\n"); } },
    { name: "repo_map", readOnly: true,
      description: "Show a compact map of the repository: files with their top-level functions, classes and types (line numbers). Optional path prefix to narrow.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      async run(a, ctx) { const m = repoMap(ctx.cwd, 14000); return a.path ? m.split(/\n(?=\S)/).filter((b) => b.startsWith(a.path.replace(/^\.\//, ""))).join("\n") || "(nothing under that path)" : m; } },
  ];
}
