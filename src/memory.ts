import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";

/** Project memory: ~/.config/atom/ATOM.md (user), then ATOM.md files from filesystem root down to cwd, plus ATOM.local.md. */
export function loadMemory(cwd: string): { files: string[]; text: string } {
  const files: string[] = [];
  for (const n of ["AGENTS.md", "ATOM.md"]) { const u = path.join(CONFIG_DIR, n); if (fs.existsSync(u)) files.push(u); }
  const chain: string[] = []; let d = path.resolve(cwd);
  while (true) { chain.unshift(d); const p = path.dirname(d); if (p === d || d === os.homedir()) break; d = p; }
  for (const dir of chain) for (const n of ["AGENTS.md", "ATOM.md", ".atom/ATOM.md", "ATOM.local.md"]) { const f = path.join(dir, n); if (fs.existsSync(f)) files.push(f); }
  const text = files.map((f) => `# Memory from ${f}\n${expandImports(fs.readFileSync(f, "utf8"), path.dirname(f), 0)}`).join("\n\n");
  return { files, text };
}
/** Support "@path/to/file" import lines, like many agent memory formats. */
function expandImports(t: string, dir: string, depth: number): string {
  if (depth > 3) return t;
  return t.replace(/^@(\S+)\s*$/gm, (m, p) => { const f = path.resolve(dir, p.replace(/^~/, os.homedir())); try { return expandImports(fs.readFileSync(f, "utf8"), path.dirname(f), depth + 1); } catch { return m; } });
}
