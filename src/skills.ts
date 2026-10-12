import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR } from "./config.js";
import { Tool } from "./tools.js";

/** Skills: folders containing a SKILL.md (YAML frontmatter with name + description, then instructions).
 *  Discovered in ~/.config/atom/skills, ~/.agents/skills, <project>/.agents/skills, <project>/.atom/skills, and plugin skills dirs.
 *  Only name+description go in the system prompt; the model loads the full body with the `skill` tool (progressive disclosure). */
export interface Skill { name: string; description: string; dir: string; file: string; body: string; disableModel?: boolean }
export function parseFrontmatter(t: string): { meta: Record<string, string>; body: string } {
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/); if (!m) return { meta: {}, body: t };
  const meta: Record<string, string> = {}; let key = "";
  for (const l of m[1].split("\n")) { const kv = l.match(/^([\w-]+):\s*(.*)$/); if (kv) { key = kv[1]; meta[key] = kv[2].replace(/^["']|["']$/g, ""); } else if (key && /^\s+/.test(l)) meta[key] += " " + l.trim(); }
  return { meta, body: m[2] };
}
export function skillDirs(cwd: string, extra: string[] = []): string[] {
  const h = os.homedir();
  return [path.join(CONFIG_DIR, "skills"), path.join(h, ".agents", "skills"), ...extra, path.join(cwd, ".agents", "skills"), path.join(cwd, ".atom", "skills")];
}
export function loadSkills(cwd: string, extra: string[] = []): Skill[] {
  const out = new Map<string, Skill>();
  for (const d of skillDirs(cwd, extra)) {
    let ents: string[] = []; try { ents = fs.readdirSync(d); } catch { continue; }
    for (const e of ents) {
      const file = path.join(d, e, "SKILL.md"); if (!fs.existsSync(file)) continue;
      const { meta, body } = parseFrontmatter(fs.readFileSync(file, "utf8"));
      const name = (meta.name || e).trim(); if (!meta.description) continue;
      out.set(name, { name, description: meta.description.trim(), dir: path.dirname(file), file, body, disableModel: meta["disable-model-invocation"] === "true" }); // later dirs (project) override
    }
  }
  return [...out.values()];
}
export function skillsPrompt(skills: Skill[]): string {
  const s = skills.filter((x) => !x.disableModel); if (!s.length) return "";
  return "Skills: specialised instructions you can load on demand. When a task matches a skill's description, call the `skill` tool with its name BEFORE starting, then follow it. Available skills:\n" + s.map((x) => `- ${x.name}: ${x.description}`).join("\n");
}
export function skillTool(skills: () => Skill[]): Tool {
  return {
    name: "skill", readOnly: true,
    description: "Load a skill's full instructions by name (see the Skills list in the system prompt). Returns SKILL.md and the skill's base directory; resolve relative paths/scripts against it.",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async run(a) {
      const s = skills().find((x) => x.name === a.name); if (!s) return `Error: no skill "${a.name}". Available: ${skills().map((x) => x.name).join(", ")}`;
      let files: string[] = []; try { files = fs.readdirSync(s.dir).filter((f) => f !== "SKILL.md"); } catch {}
      return `Skill "${s.name}" (base directory: ${s.dir})${files.length ? `\nBundled files: ${files.join(", ")}` : ""}\n\n${s.body.trim()}`;
    },
  };
}
