import fs from "node:fs";
import path from "node:path";
import { Credentials } from "./config.js";
import { RepoIndex } from "./repoindex.js";
import { CodeGraph } from "./codegraph.js";
import { runModel } from "./workersai.js";

/** Hybrid retrieval: semantic seeds -> expand along the code graph -> rerank (Workers AI bge-reranker, else rank fusion). */
export const RERANK_MODEL = "@cf/baai/bge-reranker-base";
export interface Hit { file: string; start: number; end: number; score: number; why: string; snippet: string }
const MAX_SPAN = 80;

function readSpan(root: string, file: string, start: number, end: number): string {
  try { return fs.readFileSync(path.join(root, file), "utf8").split("\n").slice(start - 1, Math.min(end, start + MAX_SPAN - 1)).join("\n"); } catch { return ""; }
}
let rerankOk: boolean | null = null;
export async function rerank(c: Credentials, query: string, texts: string[]): Promise<number[] | null> {
  if (rerankOk === false || !texts.length) return null;
  try {
    const r = await runModel(c, RERANK_MODEL, { query, contexts: texts.map((t) => ({ text: t.slice(0, 1800) })), top_k: texts.length });
    const scores = new Array(texts.length).fill(-1e9); for (const x of r.response || []) scores[x.id] = x.score; rerankOk = true; return scores;
  } catch { rerankOk = false; return null; }
}

export async function hybridSearch(c: Credentials, idx: RepoIndex, g: CodeGraph, query: string, k = 6, opts: { rerank?: boolean } = {}): Promise<Hit[]> {
  const sem = await idx.search(query, 12);
  type Cand = { file: string; start: number; end: number; prior: number; semRank?: number; why: string };
  const cands = new Map<string, Cand>();
  const put = (x: Cand) => { const key = `${x.file}:${x.start}`; const cur = cands.get(key); if (!cur || cur.prior < x.prior) cands.set(key, { ...cur, ...x, semRank: x.semRank ?? cur?.semRank }); };
  const symCand = (id: string, prior: number, why: string) => { const d = g.def(id); if (d) put({ file: d.file, start: d.line, end: Math.min(d.end, d.line + MAX_SPAN - 1), prior, why }); };
  sem.forEach((h, i) => put({ file: h.file, start: h.start, end: h.end, prior: h.score, semRank: i, why: "semantic" }));
  // graph expansion from the top seeds
  for (const h of sem.slice(0, 6)) {
    const syms = g.symbolsIn(h.file, h.start, h.end).slice(0, 4);
    for (const s of syms) {
      symCand(s, h.score * 0.95, `defined in seed ${h.file}:${h.start}`);
      for (const nb of g.neighbors(s).filter((n) => n.edge !== "defines").slice(0, 8)) symCand(nb.id, h.score * 0.8, `${nb.edge} ${nb.dir === "out" ? "from" : "to"} ${s.split("#")[1]}`);
    }
  }
  // identifiers mentioned in the query
  for (const w of new Set(query.match(/[A-Za-z_][\w]{3,}/g) || [])) for (const d of g.findSymbol(w, 4)) if (d.name === w || d.name.toLowerCase() === w.toLowerCase()) { symCand(d.id, 0.9, `named in query`); for (const x of g.callersOf(d.id).slice(0, 4)) symCand(x, 0.6, `calls ${d.name}`); }
  const list = [...cands.values()].slice(0, 48).map((x) => ({ ...x, snippet: readSpan(idx.root, x.file, x.start, x.end) })).filter((x) => x.snippet.trim());
  let scored: (typeof list[number] & { score: number })[];
  const rr = opts.rerank === false ? null : await rerank(c, query, list.map((x) => `${x.file}\n${x.snippet}`));
  if (rr) scored = list.map((x, i) => ({ ...x, score: rr[i] + (x.semRank !== undefined ? 0.02 : 0) }));
  else { // reciprocal rank fusion of semantic order and graph prior
    const byPrior = [...list].sort((a, b) => b.prior - a.prior);
    scored = list.map((x) => ({ ...x, score: 1 / (60 + byPrior.indexOf(x)) + (x.semRank !== undefined ? 1 / (60 + x.semRank) : 0) }));
  }
  scored.sort((a, b) => b.score - a.score);
  const out: Hit[] = [];
  for (const x of scored) { if (out.some((o) => o.file === x.file && x.start <= o.end && x.end >= o.start)) continue; out.push({ file: x.file, start: x.start, end: x.end, score: x.score, why: x.why, snippet: x.snippet }); if (out.length >= k) break; }
  return out;
}
