import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CONFIG_DIR, isTrusted } from "./config.js";
import { Tool } from "./tools.js";

/** Plugins: JS/TS-compiled ES modules (local files/dirs or npm packages) that extend Atom.
 *  export default function (atom) { atom.registerTool({...}); atom.registerCommand("name", {...}); atom.on("pre_tool", fn) }
 *  A plugin directory may also ship `skills/` (SKILL.md folders) and `commands/` (*.md prompt commands). */
export type PluginEvent = "session_start" | "user_prompt" | "pre_tool" | "post_tool" | "turn_end";
export interface PluginCommand { description?: string; run: (args: string, ctx: { cwd: string; say: (s: string) => void }) => Promise<string | void> | string | void }
export interface LoadedPlugin { name: string; source: string; dir?: string }
export class PluginHost {
  plugins: LoadedPlugin[] = []; tools: Tool[] = []; commands: Record<string, PluginCommand> = {}; promptCommands: Record<string, string> = {};
  skillDirs: string[] = []; handlers: Record<string, ((p: any) => any)[]> = {}; errors: string[] = [];
  constructor(public cwd: string) {}
  async emit(ev: PluginEvent, payload: any): Promise<any[]> {
    const out = []; for (const h of this.handlers[ev] || []) { try { out.push(await h(payload)); } catch (e: any) { this.errors.push(`${ev}: ${e.message}`); } } return out;
  }
  sources(settings: any): string[] {
    const s: string[] = [...(settings.plugins || [])];
    for (const d of [path.join(CONFIG_DIR, "plugins"), ...(isTrusted(this.cwd) ? [path.join(this.cwd, ".atom", "plugins")] : [])]) {
      let ents: string[] = []; try { ents = fs.readdirSync(d); } catch { continue; }
      for (const e of ents) if (e !== "node_modules" && e !== "package.json" && e !== "package-lock.json" && !e.startsWith(".")) s.push(path.join(d, e));
    }
    return [...new Set(s)];
  }
  resolve(src: string): { entry?: string; dir?: string } {
    const local = path.isAbsolute(src) ? src : src.startsWith(".") ? path.resolve(this.cwd, src) : "";
    let dir = local && fs.existsSync(local) && fs.statSync(local).isDirectory() ? local : undefined;
    if (local && !dir) return { entry: local };
    if (!dir) { // npm package: project node_modules, then ~/.config/atom/plugins/node_modules
      for (const base of [...(isTrusted(this.cwd) ? [path.join(this.cwd, "package.json")] : []), path.join(CONFIG_DIR, "plugins", "package.json")]) {
        try { dir = path.dirname(createRequire(base).resolve(src + "/package.json")); break; } catch {}
      }
      if (!dir) return {};
    }
    let entry: string | undefined;
    try { const pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); entry = pj.atom?.main || pj.exports?.["."]?.import || (typeof pj.exports === "string" ? pj.exports : undefined) || pj.main; } catch {}
    for (const c of [entry, "index.js", "index.mjs", "plugin.js", "dist/index.js"]) if (c && fs.existsSync(path.join(dir, c))) return { entry: path.join(dir, c), dir };
    return { dir };
  }
  async load(settings: any): Promise<void> {
    for (const src of this.sources(settings)) {
      const { entry, dir } = this.resolve(src); const name = path.basename(dir || entry || src).replace(/\.m?js$/, "");
      if (!entry && !dir) { this.errors.push(`plugin ${src}: not found`); continue; }
      if (dir) {
        if (fs.existsSync(path.join(dir, "skills"))) this.skillDirs.push(path.join(dir, "skills"));
        try { for (const f of fs.readdirSync(path.join(dir, "commands"))) if (f.endsWith(".md")) this.promptCommands[f.slice(0, -3)] = fs.readFileSync(path.join(dir, "commands", f), "utf8"); } catch {}
      }
      if (entry && /\.(m?js|cjs)$/.test(entry)) {
        try {
          const mod = await import(pathToFileURL(entry).href); const fn = mod.default || mod.activate;
          const api = {
            name, cwd: this.cwd, settings,
            registerTool: (t: Tool) => this.tools.push({ ...t, readOnly: !!t.readOnly, description: `[plugin ${name}] ${t.description}` }),
            registerCommand: (n: string, c: PluginCommand) => { this.commands[n] = c; },
            on: (ev: PluginEvent, h: (p: any) => any) => { (this.handlers[ev] ||= []).push(h); },
            log: (s: string) => process.stderr.write(`[${name}] ${s}\n`),
          };
          if (typeof fn === "function") await fn(api);
        } catch (e: any) { this.errors.push(`plugin ${name}: ${e.message}`); continue; }
      }
      this.plugins.push({ name, source: src, dir });
    }
  }
}
