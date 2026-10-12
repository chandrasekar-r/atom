import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, ensureDir } from "./config.js";

/** Named projects : a root folder plus per-project instructions, settings, knowledge files,
 *  memory scope and sessions. Registry: ~/.config/atom/projects.json; data: ~/.config/atom/projects/<name>/. */
export interface Project { name: string; root: string; created: number }
const REG = () => path.join(CONFIG_DIR, "projects.json");
function read(): { current?: string; projects: Record<string, Project> } { try { return JSON.parse(fs.readFileSync(REG(), "utf8")); } catch { return { projects: {} }; } }
function write(r: any) { ensureDir(CONFIG_DIR); fs.writeFileSync(REG(), JSON.stringify(r, null, 2)); }
export const projectDir = (name: string) => path.join(CONFIG_DIR, "projects", name);
export function listProjects(): { current?: string; projects: Project[] } { const r = read(); return { current: r.current, projects: Object.values(r.projects) }; }
export function addProject(name: string, root: string, instructions?: string): Project {
  if (!/^[\w.-]+$/.test(name)) throw new Error("project name: letters, digits, . _ - only");
  const r = read(); const p = { name, root: path.resolve(root), created: r.projects[name]?.created || Date.now() };
  r.projects[name] = p; r.current ||= name; write(r);
  const d = projectDir(name); ensureDir(path.join(d, "knowledge"));
  const ins = path.join(d, "INSTRUCTIONS.md"); if (!fs.existsSync(ins)) fs.writeFileSync(ins, instructions ? instructions + "\n" : `# ${name} instructions\n<!-- Loaded into every Atom session in this project. -->\n`);
  if (!fs.existsSync(path.join(d, "settings.json"))) fs.writeFileSync(path.join(d, "settings.json"), "{}\n");
  return p;
}
export function removeProject(name: string): boolean { const r = read(); if (!r.projects[name]) return false; delete r.projects[name]; if (r.current === name) r.current = Object.keys(r.projects)[0]; write(r); return true; }
export function switchProject(name: string): Project { const r = read(); if (!r.projects[name]) throw new Error(`no project ${name}`); r.current = name; write(r); return r.projects[name]; }
/** Active project: explicit name, else the project whose root contains cwd (deepest), else none. */
export function resolveProject(cwd: string, explicit?: string): Project | null {
  const r = read(); if (explicit) { if (!r.projects[explicit]) throw new Error(`no project ${explicit} (atom project list)`); return r.projects[explicit]; }
  const c = path.resolve(cwd);
  return Object.values(r.projects).filter((p) => c === p.root || c.startsWith(p.root + path.sep)).sort((a, b) => b.root.length - a.root.length)[0] || null;
}
export function currentProject(): Project | null { const r = read(); return r.current ? r.projects[r.current] || null : null; }
/** Instructions + knowledge files for the system prompt (knowledge capped at 60 KB). */
export function projectContext(p: Project): { text: string; files: string[] } {
  const d = projectDir(p.name); const files: string[] = []; let text = "";
  try { const t = fs.readFileSync(path.join(d, "INSTRUCTIONS.md"), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim(); if (t.replace(/^#.*$/m, "").trim()) { text += `# Project "${p.name}" instructions\n${t}\n`; files.push(path.join(d, "INSTRUCTIONS.md")); } } catch {}
  let budget = 60_000;
  try { for (const f of fs.readdirSync(path.join(d, "knowledge"))) { const b = fs.readFileSync(path.join(d, "knowledge", f), "utf8"); if (b.includes("\u0000") || budget <= 0) continue; const s = b.slice(0, budget); budget -= s.length; text += `\n<knowledge file="${f}">\n${s}\n</knowledge>\n`; files.push(path.join(d, "knowledge", f)); } } catch {}
  return { text, files };
}
export function projectSettings(p: Project): any { try { return JSON.parse(fs.readFileSync(path.join(projectDir(p.name), "settings.json"), "utf8")); } catch { return {}; } }
