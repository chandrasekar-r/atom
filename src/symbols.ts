import fs from "node:fs";
import path from "node:path";
import { listRepoFiles } from "./repoindex.js";

/** Lightweight, dependency-free symbol extraction (functions, classes, types, top-level consts) for @symbol mentions and repo_map. */
const RE = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/,
];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs)$/;
export interface Sym { name: string; file: string; line: number; sig: string }
export function fileSymbols(abs: string, rel: string): Sym[] {
  let text = ""; try { const st = fs.statSync(abs); if (st.size > 300_000) return []; text = fs.readFileSync(abs, "utf8"); } catch { return []; }
  const out: Sym[] = []; text.split("\n").forEach((l, i) => { for (const r of RE) { const m = l.match(r); if (m) { out.push({ name: m[1], file: rel, line: i + 1, sig: l.trim().slice(0, 140) }); break; } } });
  return out;
}
let cache: { root: string; at: number; syms: Sym[] } | null = null;
export function repoSymbols(root: string): Sym[] {
  if (cache && cache.root === root && Date.now() - cache.at < 15000) return cache.syms;
  const syms = listRepoFiles(root).filter((f) => CODE.test(f)).slice(0, 5000).flatMap((f) => fileSymbols(path.join(root, f), f));
  cache = { root, at: Date.now(), syms }; return syms;
}
/** Return the source block of a symbol: from its line to the matching closing brace/dedent (max 200 lines). */
export function symbolBody(root: string, s: Sym): string {
  const lines = fs.readFileSync(path.join(root, s.file), "utf8").split("\n"); const start = s.line - 1;
  const indent = (l: string) => l.match(/^\s*/)![0].length; const base = indent(lines[start]);
  let end = start, depth = 0, opened = false;
  for (let i = start; i < Math.min(lines.length, start + 200); i++) {
    end = i; const l = lines[i];
    for (const ch of l) { if (ch === "{") { depth++; opened = true; } else if (ch === "}") depth--; }
    if (opened && depth <= 0) break;
    if (!opened && i > start && l.trim() && indent(l) <= base && !/[\])}]/.test(l.trim()[0])) { end = i - 1; break; }
  }
  return lines.slice(start, end + 1).join("\n");
}
export function repoMap(root: string, maxChars = 12000): string {
  const by = new Map<string, Sym[]>(); for (const s of repoSymbols(root)) (by.get(s.file) || by.set(s.file, []).get(s.file)!).push(s);
  let out = ""; for (const [f, ss] of by) { const blk = `${f}\n${ss.slice(0, 30).map((s) => `  ${s.line}: ${s.sig}`).join("\n")}\n`; if (out.length + blk.length > maxChars) { out += `… (${by.size} files total; narrow with a path)\n`; break; } out += blk; }
  return out || "(no symbols found)";
}
