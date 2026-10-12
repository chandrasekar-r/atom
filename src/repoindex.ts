import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { CONFIG_DIR, Credentials, ensureDir } from "./config.js";
import { cosine, embed, EMBED_MODEL } from "./workersai.js";
import { walk } from "./tools.js";

/** Local semantic index of a repo: files (respecting .gitignore) are chunked, embedded with Workers AI bge-m3,
 *  and stored as Float32 base64 vectors in ~/.config/atom/index/<hash>.json. Re-indexing is incremental by content hash. */
interface Chunk { start: number; end: number; vec: string }
interface FileEntry { hash: string; chunks: Chunk[] }
interface IndexData { root: string; model: string; updated: number; files: Record<string, FileEntry> }
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|scala|sh|bash|zsh|sql|md|mdx|txt|json|jsonc|ya?ml|toml|ini|html|css|scss|vue|svelte|astro|lua|dart|ex|exs|r|jl|tf|proto|graphql|dockerfile)$/i;
const LINES = 60, OVERLAP = 10, MAX_FILE = 200_000;

export function listRepoFiles(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean);
  } catch {
    const ig = (() => { try { return fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")); } catch { return []; } })();
    return walk(root).filter((f) => !ig.some((p) => { const q = p.replace(/^\//, "").replace(/\/$/, ""); return f === q || f.startsWith(q + "/") || (q.startsWith("*") && f.endsWith(q.slice(1))); }));
  }
}
export function chunkText(text: string): { start: number; end: number; text: string }[] {
  const lines = text.split("\n"); const out = [];
  for (let s = 0; s < lines.length; s += LINES - OVERLAP) { const e = Math.min(lines.length, s + LINES); out.push({ start: s + 1, end: e, text: lines.slice(s, e).join("\n") }); if (e >= lines.length) break; }
  return out;
}
const enc = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");
const dec = (s: string) => { const b = Buffer.from(s, "base64"); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };

export class RepoIndex {
  file: string; data: IndexData;
  constructor(public creds: Credentials, public root: string) {
    this.file = path.join(CONFIG_DIR, "index", crypto.createHash("sha1").update(path.resolve(root)).digest("hex").slice(0, 16) + ".json");
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = { root, model: EMBED_MODEL, updated: 0, files: {} }; }
  }
  exists() { return this.data.updated > 0; }
  stats() { const f = Object.keys(this.data.files); return { files: f.length, chunks: f.reduce((n, k) => n + this.data.files[k].chunks.length, 0), updated: this.data.updated, file: this.file }; }
  clear() { try { fs.unlinkSync(this.file); } catch {} this.data = { root: this.root, model: EMBED_MODEL, updated: 0, files: {} }; }
  /** Incremental update: embed only new/changed files, drop deleted ones. */
  async update(progress?: (s: string) => void): Promise<{ added: number; changed: number; removed: number; chunks: number }> {
    const files = listRepoFiles(this.root).filter((f) => TEXT_EXT.test(f) || /(^|\/)(Dockerfile|Makefile)$/.test(f));
    const seen = new Set<string>(); const todo: { f: string; hash: string; parts: ReturnType<typeof chunkText> }[] = [];
    let added = 0, changed = 0, removed = 0;
    for (const f of files) {
      const abs = path.join(this.root, f); let st; try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > MAX_FILE) continue;
      const text = fs.readFileSync(abs, "utf8"); if (text.includes("\u0000")) continue;
      seen.add(f); const hash = crypto.createHash("sha1").update(text).digest("hex");
      const cur = this.data.files[f]; if (cur?.hash === hash) continue;
      cur ? changed++ : added++; todo.push({ f, hash, parts: chunkText(text) });
    }
    for (const f of Object.keys(this.data.files)) if (!seen.has(f)) { delete this.data.files[f]; removed++; }
    const flat = todo.flatMap((t) => t.parts.map((p) => ({ t, p })));
    let chunks = 0;
    for (let i = 0; i < flat.length; i += 64) {
      const batch = flat.slice(i, i + 64);
      const vecs = await embed(this.creds, batch.map(({ t, p }) => `${t.f}\n${p.text}`));
      batch.forEach(({ t, p }, j) => { (this.data.files[t.f] ||= { hash: "", chunks: [] }); if (this.data.files[t.f].hash !== t.hash) this.data.files[t.f] = { hash: t.hash, chunks: [] }; this.data.files[t.f].chunks.push({ start: p.start, end: p.end, vec: enc(vecs[j]) }); });
      chunks += batch.length; progress?.(`embedded ${chunks}/${flat.length} chunks`);
    }
    this.data.updated = Date.now(); ensureDir(path.dirname(this.file)); fs.writeFileSync(this.file, JSON.stringify(this.data));
    return { added, changed, removed, chunks };
  }
  async search(q: string, k = 8): Promise<{ file: string; start: number; end: number; score: number; snippet: string }[]> {
    const [qv] = await embed(this.creds, [q]);
    const hits: { file: string; start: number; end: number; score: number }[] = [];
    for (const [f, e] of Object.entries(this.data.files)) for (const c of e.chunks) hits.push({ file: f, start: c.start, end: c.end, score: cosine(qv, dec(c.vec)) });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k).map((h) => { let snippet = ""; try { snippet = fs.readFileSync(path.join(this.root, h.file), "utf8").split("\n").slice(h.start - 1, h.end).join("\n"); } catch {} return { ...h, snippet }; });
  }
}
