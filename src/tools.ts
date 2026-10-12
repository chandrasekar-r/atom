import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { lineDiff } from "./diff.js";
import { Checkpoints } from "./checkpoint.js";

export interface ToolCtx { cwd: string; checkpoints: Checkpoints; turn: number; readFiles: Set<string>; signal?: AbortSignal }
export interface Tool {
  name: string; description: string; parameters: any;
  readOnly: boolean;
  /** Short human description of what this call would do (for the permission prompt). */
  preview?(args: any, ctx: ToolCtx): string;
  run(args: any, ctx: ToolCtx): Promise<string>;
}

const abs = (ctx: ToolCtx, p: string) => (path.isAbsolute(p) ? p : path.join(ctx.cwd, p));
const IGNORE = new Set(["node_modules", ".git", "dist", ".next", "build", ".atom-cache"]);

export function globToRegex(g: string): RegExp {
  let r = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") { if (g[i + 1] === "*") { r += g[i + 2] === "/" ? "(?:.*/)?" : ".*"; i += g[i + 2] === "/" ? 2 : 1; } else r += "[^/]*"; }
    else if (c === "?") r += "[^/]";
    else if (c === "{") { const e = g.indexOf("}", i); r += "(?:" + g.slice(i + 1, e).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|") + ")"; i = e; }
    else r += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + r + "$");
}
export function walk(dir: string, base = dir, out: string[] = [], limit = 20000): string[] {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (out.length >= limit) break;
    if (IGNORE.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out, limit); else out.push(path.relative(base, p));
  }
  return out;
}

export function runShell(cmd: string, cwd: string, timeoutMs = 120000, signal?: AbortSignal): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const ch = spawn("bash", ["-lc", cmd], { cwd, env: process.env });
    let out = "";
    const add = (d: Buffer) => { out += d.toString(); if (out.length > 200000) out = out.slice(-200000); };
    ch.stdout.on("data", add); ch.stderr.on("data", add);
    const t = setTimeout(() => { ch.kill("SIGKILL"); out += `\n[timed out after ${timeoutMs}ms]`; }, timeoutMs);
    signal?.addEventListener("abort", () => ch.kill("SIGKILL"));
    ch.on("close", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
}
const clip = (s: string, n = 30000) => (s.length > n ? s.slice(0, n) + `\n...[truncated ${s.length - n} chars]` : s);

export const builtinTools: Tool[] = [
  {
    name: "read_file", readOnly: true,
    description: "Read a text file. Returns lines prefixed with line numbers. Use offset/limit for large files.",
    parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number", description: "1-based start line" }, limit: { type: "number" } }, required: ["path"] },
    async run(a, ctx) {
      const p = abs(ctx, a.path); const lines = fs.readFileSync(p, "utf8").split("\n");
      ctx.readFiles.add(p);
      const s = Math.max(1, a.offset || 1), e = Math.min(lines.length, s - 1 + (a.limit || 2000));
      return clip(lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}\t${l}`).join("\n")) + (e < lines.length ? `\n[${lines.length - e} more lines]` : "");
    },
  },
  {
    name: "write_file", readOnly: false,
    description: "Create or overwrite a file with the full given content.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    preview(a, ctx) { const p = abs(ctx, a.path); const old = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; return `write ${a.path}\n` + (old ? lineDiff(old, a.content) : a.content.split("\n").map((l: string) => "+ " + l).join("\n")); },
    async run(a, ctx) {
      const p = abs(ctx, a.path); ctx.checkpoints.record(ctx.turn, p);
      const old = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a.content); ctx.readFiles.add(p);
      return old === null ? `Created ${a.path} (${a.content.split("\n").length} lines)` : `Updated ${a.path}\n${clip(lineDiff(old, a.content), 4000)}`;
    },
  },
  {
    name: "edit_file", readOnly: false,
    description: "Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.",
    parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
    preview(a, ctx) { try { const s = fs.readFileSync(abs(ctx, a.path), "utf8"); return `edit ${a.path}\n` + lineDiff(s, a.replace_all ? s.split(a.old_string).join(a.new_string) : s.replace(a.old_string, () => a.new_string)); } catch { return `edit ${a.path}`; } },
    async run(a, ctx) {
      const p = abs(ctx, a.path); const s = fs.readFileSync(p, "utf8");
      const n = s.split(a.old_string).length - 1;
      if (n === 0) throw new Error("old_string not found in file. Read the file and copy the exact text.");
      if (n > 1 && !a.replace_all) throw new Error(`old_string matches ${n} times; add more context or set replace_all.`);
      ctx.checkpoints.record(ctx.turn, p);
      const out = a.replace_all ? s.split(a.old_string).join(a.new_string) : s.replace(a.old_string, () => a.new_string);
      fs.writeFileSync(p, out);
      return `Edited ${a.path}\n${clip(lineDiff(s, out), 4000)}`;
    },
  },
  {
    name: "glob", readOnly: true,
    description: "Find files by glob pattern (e.g. src/**/*.ts). Ignores node_modules, .git, dist.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    async run(a, ctx) {
      const root = abs(ctx, a.path || "."); const re = globToRegex(a.pattern.includes("/") ? a.pattern : "**/" + a.pattern);
      const hits = walk(root).filter((f) => re.test(f.split(path.sep).join("/")));
      return hits.length ? clip(hits.slice(0, 500).join("\n")) + (hits.length > 500 ? `\n[${hits.length - 500} more]` : "") : "No files matched.";
    },
  },
  {
    name: "grep", readOnly: true,
    description: "Search file contents with a JavaScript regex. Optional glob filter. Returns file:line:text.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, ignore_case: { type: "boolean" } }, required: ["pattern"] },
    async run(a, ctx) {
      const root = abs(ctx, a.path || "."); const re = new RegExp(a.pattern, a.ignore_case ? "i" : "");
      const g = a.glob ? globToRegex(a.glob.includes("/") ? a.glob : "**/" + a.glob) : null;
      const files = fs.statSync(root).isFile() ? [""] : walk(root);
      const out: string[] = [];
      for (const f of files) {
        if (g && !g.test(f)) continue;
        const full = f ? path.join(root, f) : root;
        let txt: string; try { const st = fs.statSync(full); if (st.size > 2e6) continue; txt = fs.readFileSync(full, "utf8"); } catch { continue; }
        if (txt.includes("\u0000")) continue;
        txt.split("\n").forEach((l, i) => { if (out.length < 300 && re.test(l)) out.push(`${f || a.path}:${i + 1}:${l.slice(0, 300)}`); });
      }
      return out.length ? out.join("\n") : "No matches.";
    },
  },
  {
    name: "bash", readOnly: false,
    description: "Run a shell command in the project directory (bash -lc). Use for builds, tests, git. Avoid interactive commands.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "number" } }, required: ["command"] },
    preview(a) { return `$ ${a.command}`; },
    async run(a, ctx) { const r = await runShell(a.command, ctx.cwd, a.timeout_ms || 120000, ctx.signal); return clip(`exit ${r.code}\n${r.out}`); },
  },
  {
    name: "web_fetch", readOnly: true,
    description: "Fetch a URL over HTTP(S) and return its text (HTML tags stripped).",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    preview(a) { return `fetch ${a.url}`; },
    async run(a) {
      const r = await fetch(a.url, { headers: { "user-agent": "atom-cli/0.2" }, redirect: "follow" });
      let t = await r.text();
      if ((r.headers.get("content-type") || "").includes("html")) t = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
      return clip(`HTTP ${r.status}\n${t.trim()}`, 20000);
    },
  },
  {
    name: "todo_write", readOnly: true,
    description: "Record or update your task plan as a checklist. Pass the full list each time.",
    parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] },
    async run(a) { return (a.todos || []).map((t: any) => `${t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]"} ${t.content}`).join("\n"); },
  },
];

export function toOpenAITools(tools: Tool[]) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}
