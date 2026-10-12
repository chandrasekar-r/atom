import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONFIG_DIR, ensureDir } from "./config.js";
import { listRepoFiles } from "./repoindex.js";

/** Code graph built with tree-sitter (WASM). Nodes: files and symbols. Edges: imports, calls, defines, inherits, references.
 *  Stored per repo in <root>/.atom/graph.json and updated incrementally by file content hash.
 *  Grammars are fetched once into ~/.config/atom/grammars. */
const GRAMMAR_VER = "0.1.13";
const LANG_BY_EXT: Record<string, string> = { ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go", ".rs": "rust", ".java": "java" };
export const langOf = (f: string) => LANG_BY_EXT[path.extname(f).toLowerCase()];

export interface Def { name: string; kind: string; line: number; end: number; parent?: string }
export interface FileRec { hash: string; lang: string; defs: Def[]; calls: { from: string; name: string; line: number }[]; imports: string[]; rawImports: string[]; inherits: { child: string; parent: string }[]; refs: { from: string; name: string }[]; pkg?: string }
export interface GraphData { version: number; updated: number; files: Record<string, FileRec> }
export type NodeId = string; // "path" or "path#Name" or "path#Parent.name"
const qn = (d: Def) => (d.parent ? d.parent + "." : "") + d.name;

let TS: any = null; const langs = new Map<string, any>();
async function grammar(lang: string): Promise<any> {
  if (langs.has(lang)) return langs.get(lang);
  if (!TS) { TS = await import("web-tree-sitter"); await TS.Parser.init(); }
  const dir = path.join(CONFIG_DIR, "grammars"); const f = path.join(dir, `tree-sitter-${lang}-${GRAMMAR_VER}.wasm`);
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://unpkg.com/tree-sitter-wasms@${GRAMMAR_VER}/out/tree-sitter-${lang}.wasm`);
    if (!r.ok) throw new Error(`download grammar ${lang}: ${r.status}`);
    ensureDir(dir); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const L = await TS.Language.load(f); const p = new TS.Parser(); p.setLanguage(L); langs.set(lang, p); return p;
}

const DEF_TYPES: Record<string, string> = {
  function_declaration: "function", generator_function_declaration: "function", method_definition: "method", class_declaration: "class", abstract_class_declaration: "class",
  interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum",
  function_definition: "function", class_definition: "class", // python
  method_declaration: "method", type_spec: "type", // go / java
  function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "trait", // rust
  constructor_declaration: "method", record_declaration: "class",
};
const CALL_TYPES = new Set(["call_expression", "call", "method_invocation", "new_expression", "object_creation_expression"]);
function lastIdent(n: any): string | null {
  if (!n) return null;
  if (/identifier$/.test(n.type) || n.type === "property_identifier" || n.type === "field_identifier") return n.text;
  for (const f of ["property", "attribute", "field", "name"]) { const c = n.childForFieldName?.(f); if (c) return lastIdent(c); }
  if (n.type === "generic_function" || n.type === "generic_type") return lastIdent(n.namedChildren[0]);
  const kids = n.namedChildren || []; return kids.length ? lastIdent(kids[kids.length - 1]) : null;
}
function stringLit(n: any): string { return n.text.replace(/^[`'"]|[`'"]$/g, ""); }

/** Parse one file into a FileRec. */
export async function parseFile(text: string, lang: string): Promise<Omit<FileRec, "hash" | "imports">> {
  const parser = await grammar(lang); const tree = parser.parse(text);
  const rec: Omit<FileRec, "hash" | "imports"> = { lang, defs: [], calls: [], rawImports: [], inherits: [], refs: [] };
  const stack: { n: any; owner: string; cls?: string }[] = [{ n: tree.rootNode, owner: "" }];
  const refSeen = new Set<string>();
  while (stack.length) {
    const { n, owner, cls } = stack.pop()!; let nextOwner = owner, nextCls = cls;
    const t = n.type;
    // definitions
    let kind = DEF_TYPES[t]; let nameNode = kind ? n.childForFieldName("name") : null;
    if (t === "variable_declarator" && /^(arrow_function|function|function_expression)$/.test(n.childForFieldName("value")?.type || "")) { kind = "function"; nameNode = n.childForFieldName("name"); }
    if (t === "impl_item") { const ty = lastIdent(n.childForFieldName("type")); const tr = lastIdent(n.childForFieldName("trait")); if (ty) { nextCls = ty; if (tr) rec.inherits.push({ child: ty, parent: tr }); } }
    if (kind && nameNode) {
      const name = nameNode.text; const isMethod = !!cls && (kind === "function" || kind === "method");
      const d: Def = { name, kind: isMethod ? "method" : kind, line: n.startPosition.row + 1, end: n.endPosition.row + 1, ...(isMethod ? { parent: cls } : {}) };
      if (t === "method_declaration" && lang === "go") { const recv = n.childForFieldName("receiver"); const rt = recv ? lastIdent(recv.descendantsOfType ? recv.descendantsOfType("type_identifier")[0] : null) : null; if (rt) d.parent = rt; d.kind = "method"; }
      rec.defs.push(d); nextOwner = qn(d);
      if (/class|interface|struct|trait|type/.test(kind)) {
        nextCls = name;
        // inheritance
        const heads: any[] = [];
        for (const f of ["superclass", "superclasses", "interfaces", "super_interfaces"]) { const c = n.childForFieldName(f); if (c) heads.push(c); }
        for (const c of n.namedChildren) if (/class_heritage|extends_clause|implements_clause|extends_type_clause|superclass|super_interfaces|extends_interfaces/.test(c.type)) heads.push(c);
        for (const h of heads) for (const id of (h.descendantsOfType ? h.descendantsOfType(["identifier", "type_identifier"]) : [])) if (id.text !== name) rec.inherits.push({ child: name, parent: id.text });
      }
    }
    // calls
    if (CALL_TYPES.has(t)) {
      const fn = n.childForFieldName("function") || n.childForFieldName("constructor") || n.childForFieldName("type") || (t === "method_invocation" ? n.childForFieldName("name") : null);
      const name = lastIdent(fn);
      if (name) {
        rec.calls.push({ from: owner, name, line: n.startPosition.row + 1 });
        if (lang !== "python" && name === "require" && t === "call_expression") { const a = n.childForFieldName("arguments")?.namedChildren[0]; if (a?.type === "string") rec.rawImports.push(stringLit(a)); }
      }
    }
    // imports
    if (t === "import_statement" || t === "export_statement") { const s = n.childForFieldName("source"); if (s) rec.rawImports.push(stringLit(s)); }
    if (lang === "python" && t === "import_statement") for (const c of n.namedChildren) rec.rawImports.push((c.childForFieldName?.("name") || c).text);
    if (lang === "python" && t === "import_from_statement") { const m = n.childForFieldName("module_name"); if (m) rec.rawImports.push(m.text); }
    if (t === "import_spec") { const p = n.childForFieldName("path"); if (p) rec.rawImports.push(stringLit(p)); }
    if (t === "use_declaration") rec.rawImports.push(n.text.replace(/^(pub\s+)?use\s+/, "").replace(/;$/, ""));
    if (t === "mod_item" && !n.childForFieldName("body")) rec.rawImports.push("mod:" + n.childForFieldName("name")?.text);
    if (t === "import_declaration" && lang === "java") rec.rawImports.push(n.text.replace(/^import\s+(static\s+)?/, "").replace(/;$/, "").trim());
    if (t === "package_clause" || t === "package_declaration") rec.pkg = n.namedChildren[0]?.text;
    // type references
    if (t === "type_identifier" && owner) { const k = owner + ">" + n.text; if (!refSeen.has(k)) { refSeen.add(k); rec.refs.push({ from: owner, name: n.text }); } }
    const kids = n.namedChildren; for (let i = kids.length - 1; i >= 0; i--) stack.push({ n: kids[i], owner: nextOwner, cls: nextCls });
  }
  tree.delete?.();
  return rec;
}

/** Resolve raw import strings to repo files. */
function resolveImports(file: string, rec: FileRec, all: Set<string>, byDir: Map<string, string[]>, javaIdx: Map<string, string>): string[] {
  const out = new Set<string>(); const dir = path.posix.dirname(file);
  const tryFiles = (base: string, exts: string[]) => { for (const e of exts) { const c = path.posix.normalize(base + e); if (all.has(c)) { out.add(c); return true; } } return false; };
  for (const raw of rec.rawImports) {
    if (rec.lang === "typescript" || rec.lang === "tsx" || rec.lang === "javascript") {
      if (!raw.startsWith(".")) continue; const b = path.posix.join(dir, raw).replace(/\.(m?js|cjs|jsx)$/, "");
      tryFiles(b, ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", "/index.ts", "/index.tsx", "/index.js"]);
    } else if (rec.lang === "python") {
      const dots = raw.match(/^\.*/)![0].length; let mod = raw.slice(dots).replace(/\./g, "/");
      const bases = dots ? [path.posix.join(dir, "../".repeat(Math.max(0, dots - 1)), mod)] : [mod, path.posix.join(dir, mod)];
      for (const b of bases) { if (tryFiles(b, [".py", "/__init__.py"])) break; // also suffix match from any source root
        const suf = "/" + mod + ".py"; for (const f of all) if (f.endsWith(suf)) { out.add(f); break; } }
    } else if (rec.lang === "go") {
      for (const [d, fs_] of byDir) if (raw.endsWith("/" + d) || raw === d) fs_.filter((f) => f.endsWith(".go") && !f.endsWith("_test.go")).forEach((f) => out.add(f));
    } else if (rec.lang === "rust") {
      if (raw.startsWith("mod:")) { const m = raw.slice(4); tryFiles(path.posix.join(dir, m), [".rs", "/mod.rs"]); continue; }
      const parts = raw.replace(/\{.*$/, "").split("::").filter(Boolean);
      if (parts[0] === "crate" || parts[0] === "super" || parts[0] === "self") {
        const root = parts[0] === "crate" ? (file.includes("src/") ? file.slice(0, file.indexOf("src/") + 4) : "") : parts[0] === "super" ? path.posix.dirname(dir) + "/" : dir + "/";
        for (let k = parts.length; k > 1; k--) if (tryFiles(root + parts.slice(1, k).join("/"), [".rs", "/mod.rs"])) break;
      }
    } else if (rec.lang === "java") {
      const cls = raw.replace(/\.\*$/, ""); const hit = javaIdx.get(cls); if (hit) out.add(hit);
      else if (raw.endsWith(".*")) for (const [k, v] of javaIdx) if (k.startsWith(cls + ".") && !k.slice(cls.length + 1).includes(".")) out.add(v);
    }
  }
  out.delete(file); return [...out];
}

export class CodeGraph {
  file: string; data: GraphData;
  // derived indexes
  private nameIdx = new Map<string, NodeId[]>(); private callers = new Map<NodeId, Set<NodeId>>(); private callees = new Map<NodeId, Set<NodeId>>();
  private importers = new Map<string, Set<string>>(); private subclasses = new Map<NodeId, Set<NodeId>>(); private supers = new Map<NodeId, Set<NodeId>>();
  private refsIn = new Map<NodeId, Set<NodeId>>(); private refsOut = new Map<NodeId, Set<NodeId>>(); private built = false;
  constructor(public root: string) {
    this.file = path.join(root, ".atom", "graph.json");
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); if (this.data.version !== 2) throw 0; } catch { this.data = { version: 2, updated: 0, files: {} }; }
  }
  exists() { return this.data.updated > 0; }
  stats() {
    this.build(); const f = Object.values(this.data.files);
    let edges = 0; for (const m of [this.callees, this.refsOut]) for (const s of m.values()) edges += s.size; for (const r of f) edges += r.imports.length + r.defs.length + r.inherits.length;
    return { files: f.length, symbols: f.reduce((n, r) => n + r.defs.length, 0), edges, langs: [...new Set(f.map((r) => r.lang))], updated: this.data.updated, file: this.file };
  }
  async update(progress?: (s: string) => void): Promise<{ parsed: number; removed: number; errors: number }> {
    const files = listRepoFiles(this.root).filter((f) => langOf(f) && !/(^|\/)(node_modules|vendor|dist|build)\//.test(f));
    const seen = new Set(files); let parsed = 0, removed = 0, errors = 0;
    for (const f of Object.keys(this.data.files)) if (!seen.has(f)) { delete this.data.files[f]; removed++; }
    for (const f of files) {
      let text: string; try { const abs = path.join(this.root, f); if (fs.statSync(abs).size > 500_000) continue; text = fs.readFileSync(abs, "utf8"); } catch { continue; }
      const hash = crypto.createHash("sha1").update(text).digest("hex"); if (this.data.files[f]?.hash === hash) continue;
      try { const r = await parseFile(text, langOf(f)); this.data.files[f] = { ...r, hash, imports: [] }; parsed++; } catch { errors++; }
      if (parsed % 50 === 0) progress?.(`parsed ${parsed} files`);
    }
    // import resolution is cheap; redo it globally so new files resolve
    const all = new Set(Object.keys(this.data.files)); const byDir = new Map<string, string[]>(); const javaIdx = new Map<string, string>();
    for (const f of all) { const d = path.posix.dirname(f); (byDir.get(d) || byDir.set(d, []).get(d)!).push(f); const r = this.data.files[f]; if (r.lang === "java" && r.pkg) javaIdx.set(r.pkg + "." + path.basename(f, ".java"), f); }
    for (const f of all) this.data.files[f].imports = resolveImports(f, this.data.files[f], all, byDir, javaIdx);
    this.data.updated = Date.now(); ensureDir(path.dirname(this.file)); fs.writeFileSync(this.file, JSON.stringify(this.data)); this.built = false;
    return { parsed, removed, errors };
  }
  /** Build adjacency: resolve call/ref names to symbol nodes, preferring same file, then imported files, then same language anywhere. */
  build() {
    if (this.built) return; this.built = true;
    for (const m of [this.nameIdx, this.callers, this.callees, this.importers, this.subclasses, this.supers, this.refsIn, this.refsOut]) m.clear();
    for (const [f, r] of Object.entries(this.data.files)) for (const d of r.defs) { const l = this.nameIdx.get(d.name) || this.nameIdx.set(d.name, []).get(d.name)!; const id = `${f}#${qn(d)}`; if (!l.includes(id)) l.push(id); }
    const add = (m: Map<string, Set<string>>, a: string, b: string) => (m.get(a) || m.set(a, new Set()).get(a)!).add(b);
    const resolve = (f: string, r: FileRec, name: string): NodeId[] => {
      const c = this.nameIdx.get(name); if (!c) return [];
      const same = c.filter((x) => x.startsWith(f + "#")); if (same.length) return same;
      const imp = c.filter((x) => r.imports.includes(x.slice(0, x.indexOf("#")))); if (imp.length) return imp;
      const lang = c.filter((x) => this.data.files[x.slice(0, x.indexOf("#"))]?.lang.replace("tsx", "typescript").replace("javascript", "typescript") === r.lang.replace("tsx", "typescript").replace("javascript", "typescript"));
      return lang.length <= 3 ? lang : []; // ambiguous common names are dropped
    };
    for (const [f, r] of Object.entries(this.data.files)) {
      for (const i of r.imports) add(this.importers, i, f);
      for (const c of r.calls) { const from = c.from ? `${f}#${c.from}` : f; for (const to of resolve(f, r, c.name)) if (to !== from) { add(this.callees, from, to); add(this.callers, to, from); } }
      for (const h of r.inherits) for (const p of resolve(f, r, h.parent)) { const ch = `${f}#${h.child}`; add(this.supers, ch, p); add(this.subclasses, p, ch); }
      for (const x of r.refs) for (const to of resolve(f, r, x.name)) { const from = `${f}#${x.from}`; if (to !== from) { add(this.refsOut, from, to); add(this.refsIn, to, from); } }
    }
  }
  def(id: NodeId): (Def & { file: string }) | null { const i = id.indexOf("#"); if (i < 0) return null; const f = id.slice(0, i), n = id.slice(i + 1); const d = this.data.files[f]?.defs.find((x) => qn(x) === n) || this.data.files[f]?.defs.find((x) => x.name === n); return d ? { ...d, file: f } : null; }
  /** Find symbols by name: exact, then case-insensitive, then substring. Accepts "file#Name" and "Class.method". */
  findSymbol(q: string, limit = 20): (Def & { file: string; id: NodeId })[] {
    this.build(); if (q.includes("#")) { const d = this.def(q); return d ? [{ ...d, id: q }] : []; }
    let name = q, parent: string | undefined; if (/^[\w$]+\.[\w$]+$/.test(q)) [parent, name] = q.split(".");
    const pick = (ids: string[]) => ids.map((id) => ({ ...this.def(id)!, id })).filter((d) => d.name && (!parent || d.parent === parent));
    let r = pick(this.nameIdx.get(name) || []); if (r.length) return r.slice(0, limit);
    const low = name.toLowerCase(); const keys = [...this.nameIdx.keys()];
    r = pick(keys.filter((k) => k.toLowerCase() === low).flatMap((k) => this.nameIdx.get(k)!)); if (r.length) return r.slice(0, limit);
    return pick(keys.filter((k) => k.toLowerCase().includes(low)).flatMap((k) => this.nameIdx.get(k)!)).slice(0, limit);
  }
  resolveNode(q: string): NodeId[] { if (this.data.files[q]) return [q]; return this.findSymbol(q, 10).map((d) => d.id); }
  callersOf(id: NodeId) { this.build(); return [...(this.callers.get(id) || [])]; }
  calleesOf(id: NodeId) { this.build(); return [...(this.callees.get(id) || [])]; }
  /** Direct neighbours with edge labels. */
  neighbors(id: NodeId): { id: NodeId; edge: string; dir: "in" | "out" }[] {
    this.build(); const out: { id: NodeId; edge: string; dir: "in" | "out" }[] = [];
    const push = (m: Map<string, Set<string>>, edge: string, dir: "in" | "out") => { for (const x of m.get(id) || []) out.push({ id: x, edge, dir }); };
    push(this.callees, "calls", "out"); push(this.callers, "calls", "in"); push(this.supers, "inherits", "out"); push(this.subclasses, "inherits", "in"); push(this.refsOut, "references", "out"); push(this.refsIn, "references", "in");
    const file = id.includes("#") ? id.slice(0, id.indexOf("#")) : id; const r = this.data.files[file];
    if (!id.includes("#") && r) { for (const d of r.defs) out.push({ id: `${file}#${qn(d)}`, edge: "defines", dir: "out" }); for (const i of r.imports) out.push({ id: i, edge: "imports", dir: "out" }); for (const i of this.importers.get(file) || []) out.push({ id: i, edge: "imports", dir: "in" }); }
    else if (r) out.push({ id: file, edge: "defines", dir: "in" });
    return out;
  }
  neighborhood(id: NodeId, depth = 1, max = 60) {
    const nodes = new Set([id]); const edges: { from: NodeId; to: NodeId; edge: string }[] = []; let frontier = [id];
    for (let d = 0; d < depth && nodes.size < max; d++) {
      const next: NodeId[] = [];
      for (const n of frontier) for (const nb of this.neighbors(n)) {
        const e = nb.dir === "out" ? { from: n, to: nb.id, edge: nb.edge } : { from: nb.id, to: n, edge: nb.edge };
        if (!edges.some((x) => x.from === e.from && x.to === e.to && x.edge === e.edge)) edges.push(e);
        if (!nodes.has(nb.id) && nodes.size < max) { nodes.add(nb.id); next.push(nb.id); }
      }
      frontier = next;
    }
    return { nodes: [...nodes], edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)) };
  }
  /** Everything that (transitively) depends on a node: callers, subclasses, referrers, and importers of its file. */
  impact(id: NodeId, maxDepth = 4): { id: NodeId; depth: number; via: string }[] {
    this.build(); const seen = new Map<NodeId, { depth: number; via: string }>([[id, { depth: 0, via: "" }]]); let frontier = [id];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: NodeId[] = [];
      for (const n of frontier) {
        const deps: [NodeId, string][] = [];
        for (const x of this.callers.get(n) || []) deps.push([x, "calls"]); for (const x of this.subclasses.get(n) || []) deps.push([x, "inherits"]); for (const x of this.refsIn.get(n) || []) deps.push([x, "references"]);
        const file = n.includes("#") ? n.slice(0, n.indexOf("#")) : n; if (!n.includes("#")) for (const x of this.importers.get(file) || []) deps.push([x, "imports"]);
        for (const [x, via] of deps) if (!seen.has(x)) { seen.set(x, { depth: d, via }); next.push(x); }
      }
      frontier = next;
    }
    seen.delete(id); return [...seen].map(([k, v]) => ({ id: k, ...v })).sort((a, b) => a.depth - b.depth);
  }
  label(id: NodeId) { const d = this.def(id); return d ? `${d.file}:${d.line} ${d.parent ? d.parent + "." : ""}${d.name} (${d.kind})` : id; }
  export(fmt: "dot" | "mermaid", focus?: NodeId, depth = 2): string {
    let nodes: NodeId[], edges: { from: NodeId; to: NodeId; edge: string }[];
    if (focus) ({ nodes, edges } = this.neighborhood(focus, depth, 150));
    else { nodes = Object.keys(this.data.files); edges = Object.entries(this.data.files).flatMap(([f, r]) => r.imports.map((i) => ({ from: f, to: i, edge: "imports" }))); }
    const idx = new Map(nodes.map((n, i) => [n, `n${i}`]));
    if (fmt === "dot") return `digraph atom {\n  rankdir=LR; node [shape=box,fontsize=10];\n${nodes.map((n) => `  ${idx.get(n)} [label=${JSON.stringify(n)}${n.includes("#") ? "" : ",style=filled,fillcolor=\"#eeeeee\""}];`).join("\n")}\n${edges.map((e) => `  ${idx.get(e.from)} -> ${idx.get(e.to)} [label="${e.edge}"];`).join("\n")}\n}\n`;
    const esc = (s: string) => s.replace(/"/g, "'");
    return `graph LR\n${nodes.map((n) => `  ${idx.get(n)}["${esc(n)}"]`).join("\n")}\n${edges.map((e) => `  ${idx.get(e.from)} -->|${e.edge}| ${idx.get(e.to)}`).join("\n")}\n`;
  }
  /** Symbols whose line span overlaps a range in a file. */
  symbolsIn(file: string, start: number, end: number): NodeId[] { return (this.data.files[file]?.defs || []).filter((d) => d.line <= end && d.end >= start && d.end - d.line < 400).map((d) => `${file}#${qn(d)}`); }
}
