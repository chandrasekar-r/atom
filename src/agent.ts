import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Credentials, Settings, saveProjectAllow } from "./config.js";
import { chat, Msg } from "./provider.js";
import { Tool, ToolCtx, toOpenAITools } from "./tools.js";
import { Checkpoints } from "./checkpoint.js";
import { runHooks } from "./hooks.js";
import { Session, newSession } from "./session.js";
import type { LongTermMemory, Route } from "./ltm.js";
import type { PluginHost } from "./plugins.js";
import type { Skill } from "./skills.js";
import { skillsPrompt } from "./skills.js";

/** Optional subsystems wired in by the CLI. */
export interface Extensions { ltm?: LongTermMemory; plugins?: PluginHost; skills?: () => Skill[]; context?: string; agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string }>; route?: boolean }

export type Mode = "ask" | "auto" | "plan" | "bypass";
export type Decision = "yes" | "always" | "no";
export interface UI {
  text(t: string): void;            // streamed assistant text
  reasoning(t: string): void;       // streamed thinking (dim)
  toolStart(name: string, summary: string): void;
  toolEnd(name: string, result: string, ok: boolean): void;
  ask(tool: Tool, preview: string): Promise<Decision>;
  info(t: string): void;
  /** Optional rich hooks used by the TUI. */
  todos?(list: { content: string; status: string }[]): void;
  usage?(u: { prompt: number; completion: number }): void;
  compacting?(auto: boolean): void;
}
export const CONTEXT_TOKENS = 128_000;

export function systemPrompt(cwd: string, memory: string, mode: Mode, ext: Extensions = {}): string {
  return [
    "You are Atom, a terminal coding agent working in the user's project directory. You help with software engineering tasks: reading code, editing files, running commands and tests.",
    `Working directory: ${cwd}\nPlatform: ${os.platform()} ${os.release()}\nDate: ${new Date().toISOString().slice(0, 10)}`,
    "Guidelines:\n- Use tools to inspect before changing. Read a file before editing it.\n- Prefer edit_file with a small unique old_string over rewriting whole files.\n- Use glob/grep to find code. Run tests or builds with bash to verify changes.\n- Keep answers short and direct; the user sees tool output. Do not invent file contents.\n- For multi-step work, track progress with todo_write (keep exactly one item in_progress).\n- For broad searches or independent sub-tasks, delegate with the task tool; it runs a subagent with a fresh context and returns its report.\n- When finished, give a brief summary of what changed.",
    mode === "plan" ? "PLAN MODE IS ON: you may only use read-only tools. Investigate, then present a concise step-by-step plan. Do not modify files or run commands." : "",
    "Search: use semantic_search (hybrid: embeddings + code graph + reranker) to find code by meaning, grep for exact strings, repo_map for an overview. Use find_symbol / find_callers / find_callees to navigate, and impact_analysis before changing a shared function, class or file. Use web_search (then web_fetch) for anything that needs current information from the internet. Long-term memory: call memory_save when the user asks you to remember something or states a lasting preference.",
    ext.skills ? skillsPrompt(ext.skills()) : "",
    ext.context || "",
    memory ? "Project memory (instructions from AGENTS.md / ATOM.md files; follow them):\n" + memory : "",
  ].filter(Boolean).join("\n\n");
}

const summarize = (name: string, a: any) => {
  if (name === "todo_write") return `${(a.todos || []).length} items`; if (name === "task") return a.description || String(a.prompt || "").slice(0, 60);
  if (name === "bash") return a.command; if (a.path) return a.path + (a.pattern ? ` /${a.pattern}/` : "");
  if (a.pattern) return a.pattern; if (a.url) return a.url; return JSON.stringify(a).slice(0, 80);
};

export class Agent {
  checkpoints: Checkpoints;
  readFiles = new Set<string>();
  abort?: AbortController;
  constructor(public creds: Credentials, public session: Session, public tools: Tool[], public settings: Settings, public ui: UI, public mode: Mode, public memory: string, public ext: Extensions = {}) {
    this.checkpoints = new Checkpoints(session.snapshots);
    if (!tools.some((t) => t.name === "task")) this.tools = [...tools, this.taskTool()];
  }
  depth = 0;
  lastRoute: Route | null = null;
  lastPrompt = 0;
  /** Subagent tool: fresh context, same tools minus task, returns final report. */
  taskTool(): Tool {
    const self = this;
    return {
      name: "task", readOnly: false,
      get description() { return "Launch a subagent with a fresh context to handle a self-contained sub-task (e.g. search the codebase, investigate a bug, review files). Give it a complete, standalone prompt. It returns a final report. Use read-only subagents (readonly: true) for exploration." + (Object.keys(self.ext.agents || {}).length ? " Custom agents (pass as agent): " + Object.entries(self.ext.agents!).map(([k, v]) => `${k}: ${v.description}`).join("; ") : ""); },
      parameters: { type: "object", properties: { description: { type: "string", description: "3-5 word label" }, prompt: { type: "string" }, readonly: { type: "boolean" }, agent: { type: "string", description: "optional custom agent type from .atom/agents" } }, required: ["description", "prompt"] },
      preview: (a) => `subagent: ${a.description}\n${a.prompt}`,
      run: async (a) => {
        if (this.depth >= 1) return "Error: subagents cannot spawn subagents.";
        const sub = newSession(this.cwd, this.session.model);
        const parentUi = this.ui;
        const ui: UI = {
          text: () => {}, reasoning: () => {}, info: () => {},
          toolStart: (n, sm) => parentUi.toolStart("  ↳ " + n, sm), toolEnd: (n, r, ok) => parentUi.toolEnd("  ↳ " + n, r.split("\n")[0], ok),
          ask: (t, p) => parentUi.ask(t, p),
        };
        const def = a.agent ? this.ext.agents?.[a.agent] : undefined;
        if (a.agent && !def) return `Error: no agent "${a.agent}". Available: ${Object.keys(this.ext.agents || {}).join(", ") || "none"}`;
        if (def?.model) sub.model = def.model;
        const tools = this.tools.filter((t) => t.name !== "task" && (!(a.readonly || this.mode === "plan") || t.readOnly) && (!def?.tools || def.tools.includes(t.name)));
        const child = new Agent(this.creds, sub, tools, this.settings, ui, a.readonly || this.mode === "plan" ? "plan" : this.mode, this.memory + (def ? `\n\n# Agent role: ${a.agent}\n${def.prompt}` : ""), { ...this.ext, ltm: undefined });
        child.depth = this.depth + 1; child.tools = tools;
        const out = await child.run(a.prompt + "\n\nWhen done, reply with a concise final report of findings/changes (this is returned to the parent agent).");
        this.session.usage.prompt += sub.usage.prompt; this.session.usage.completion += sub.usage.completion; this.session.usage.neurons += sub.usage.neurons;
        for (const sn of child.checkpoints.snaps) this.checkpoints.snaps.push({ ...sn, turn: this.session.turn });
        return out || "(subagent returned no text)";
      },
    };
  }
  get cwd() { return this.session.cwd; }

  allowed(tool: Tool, args: any): boolean {
    const rules = this.settings.allow || [];
    if (rules.includes(tool.name)) return true;
    if (tool.name === "bash") return bashRuleAllows(rules, String(args.command ?? ""));
    return false;
  }
  async permit(tool: Tool, args: any): Promise<boolean> {
    if (tool.name === "task") return true;
    if (tool.readOnly && tool.name !== "web_fetch" && !needsReadApproval(tool, args, this.cwd)) return true;
    if (this.mode === "bypass" || this.allowed(tool, args)) return true;
    if (this.mode === "auto" && (tool.name === "write_file" || tool.name === "edit_file")) return true;
    const d = await this.ui.ask(tool, tool.preview ? tool.preview(args, this.ctx()) : JSON.stringify(args));
    if (d === "always") {
      const rule = tool.name === "bash" ? `bash:${String(args.command).split(" ")[0]} *` : tool.name;
      (this.settings.allow ||= []).push(rule); saveProjectAllow(this.cwd, rule);
    }
    return d !== "no";
  }
  ctx(): ToolCtx { return { cwd: this.cwd, checkpoints: this.checkpoints, turn: this.session.turn, readFiles: this.readFiles, signal: this.abort?.signal }; }

  activeTools(): Tool[] { return this.mode === "plan" ? this.tools.filter((t) => t.readOnly || t.name === "task") : this.tools; }

  async run(prompt: string, images: string[] = []): Promise<string> {
    const s = this.session;
    const h = await runHooks(this.settings, "UserPromptSubmit", { prompt }, this.cwd);
    if (h.blocked) { this.ui.info("Prompt blocked by hook: " + h.output); return ""; }
    for (const r of (await this.ext.plugins?.emit("user_prompt", { prompt, cwd: this.cwd })) || []) { if (r?.block) { this.ui.info("Prompt blocked by plugin: " + r.block); return ""; } if (typeof r?.prompt === "string") prompt = r.prompt; if (r?.context) h.output += (h.output ? "\n" : "") + r.context; }
    s.turn += 1; s.turnIndex[s.turn] = s.messages.length;
    const raw = prompt.split(/\n\n<(?:file|directory) /)[0];
    if (!s.title) s.title = raw.slice(0, 60);
    // Long-term memory: Clef-flash routes the prompt (remember? recall? intent), bge-m3 recalls relevant memories.
    let route: Route | null = null, recalled = "";
    const ltm = this.ext.ltm;
    if (ltm && this.ext.route !== false) {
      try {
        const [rt, hits] = await Promise.all([ltm.route(raw), ltm.visible().length ? ltm.search(raw, 5, 0.3) : Promise.resolve([])]);
        route = rt; this.lastRoute = rt;
        const use = hits.filter((m) => m.score >= (this.settings.memory?.threshold ?? 0.42) || (rt.recall >= 0.5 && m.score >= 0.35));
        if (use.length) { recalled = use.map((m) => `- ${m.text}`).join("\n"); this.ui.info(`\x1b[2m✻ recalled ${use.length} memor${use.length > 1 ? "ies" : "y"}\x1b[0m`); }
      } catch (e: any) { this.ui.info(`\x1b[2m(memory unavailable: ${e.message.slice(0, 80)})\x1b[0m`); }
    }
    const text = prompt + (h.output ? `\n\n[hook context]\n${h.output}` : "") + (recalled ? `\n\n[Long-term memory: things the user told you in earlier sessions; use if relevant]\n${recalled}` : "") + (route?.intent === "web" && (route.intents.web ?? 0) > 0.6 ? "\n\n[router: this likely needs current web information; use web_search]" : "");
    s.messages.push({ role: "user", content: images.length ? [{ type: "text", text }, ...images.map((url) => ({ type: "image_url", image_url: { url } }))] : text });
    this.abort = new AbortController();
    let final = "";
    try {
      for (let step = 0; step < 50; step++) {
        const limit = this.settings.autoCompactTokens || CONTEXT_TOKENS * 0.75;
        if (this.settings.autoCompact !== false && s.messages.length > 4 && (this.lastPrompt > limit || JSON.stringify(s.messages).length > 400_000)) { this.ui.compacting?.(true); await this.compact(); this.lastPrompt = 0; }
        const sys: Msg = { role: "system", content: systemPrompt(this.cwd, this.memory, this.mode, this.ext) };
        const tools = this.activeTools();
        const r = await chat(this.creds, s.model, [sys, ...s.messages], toOpenAITools(tools), (t) => this.ui.text(t), (t) => this.ui.reasoning(t), this.abort.signal);
        s.usage.prompt += r.usage.prompt; s.usage.completion += r.usage.completion; s.usage.neurons += r.usage.neurons;
        if (r.usage.prompt) this.lastPrompt = r.usage.prompt; this.ui.usage?.(r.usage);
        const am: Msg = { role: "assistant", content: r.content || "" };
        if (r.toolCalls.length) am.tool_calls = r.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments || "{}" } }));
        s.messages.push(am);
        if (r.content) final = r.content;
        if (!r.toolCalls.length) break;
        for (const c of r.toolCalls) {
          const tool = tools.find((t) => t.name === c.name);
          let result: string, ok = true;
          let args: any = {};
          try { args = JSON.parse(c.arguments || "{}"); } catch { }
          if (!tool) { result = `Error: unknown tool ${c.name}`; ok = false; }
          else {
            this.ui.toolStart(c.name, summarize(c.name, args));
            const pre = await runHooks(this.settings, "PreToolUse", { tool: c.name, input: args }, this.cwd);
            const pb = ((await this.ext.plugins?.emit("pre_tool", { tool: c.name, input: args, cwd: this.cwd })) || []).find((x) => x?.block);
            if (pb) { result = `Blocked by plugin: ${pb.block}`; ok = false; }
            else if (pre.blocked) { result = `Blocked by PreToolUse hook: ${pre.output}`; ok = false; }
            else if (!(await this.permit(tool, args))) { result = "The user denied this tool call. Ask what they want instead, or try another approach."; ok = false; }
            else {
              if (c.name === "todo_write") this.ui.todos?.(args.todos || []);
              try { result = await tool.run(args, this.ctx()); } catch (e: any) { result = `Error: ${e.message}`; ok = false; }
              const post = await runHooks(this.settings, "PostToolUse", { tool: c.name, input: args, output: result.slice(0, 5000) }, this.cwd);
              if (post.output) result += `\n[hook] ${post.output}`;
              for (const x of (await this.ext.plugins?.emit("post_tool", { tool: c.name, input: args, output: result, cwd: this.cwd })) || []) if (typeof x === "string" && x) result += `\n[plugin] ${x}`;
            }
          }
          this.ui.toolEnd(c.name, result, ok);
          s.messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: result });
        }
      }
    } finally {
      s.snapshots = this.checkpoints.snaps;
      await runHooks(this.settings, "Stop", { session: s.id }, this.cwd);
      await this.ext.plugins?.emit("turn_end", { session: s.id, prompt: raw, reply: final });
    }
    // Auto-extract durable facts when the classifier says the prompt is memory-worthy (and the model didn't already save it).
    const saved = s.messages.slice(s.turnIndex[s.turn]).some((m) => m.tool_calls?.some((t: any) => t.function.name === "memory_save"));
    if (ltm && route && !saved && route.remember >= ((this.settings as any).memory?.rememberThreshold ?? 0.6)) {
      try { const facts = await ltm.extract(raw, final); const out = []; for (const f of facts) { const m = await ltm.add(f.text, f.kind); if (m) out.push(m.text); } if (out.length) this.ui.info(`\x1b[2m✻ remembered: ${out.join(" · ")}\x1b[0m`); } catch {}
    }
    return final;
  }

  /** Replace the history with a model-written summary, keeping the last user message. */
  async compact(focus = ""): Promise<string> {
    const s = this.session;
    const transcript = s.messages.map((m) => `${m.role}${m.name ? `(${m.name})` : ""}: ${(typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content).replace(/data:image[^"]+/g, "[image]") : JSON.stringify(m.tool_calls || "")).slice(0, 3000)}`).join("\n");
    const r = await chat(this.creds, s.model, [
      { role: "system", content: "Summarize this coding-session transcript so work can continue. Include: the user's goals, key decisions, files touched and their current state, commands run and results, open TODOs. Be concise but complete." + (focus ? ` Focus on: ${focus}` : "") },
      { role: "user", content: transcript.slice(-200000) },
    ], []);
    s.messages = [{ role: "user", content: "[Summary of earlier conversation]\n" + r.content }, { role: "assistant", content: "Understood. I have the context and will continue from here." }];
    s.turnIndex = {};
    return r.content;
  }

  /** Rewind conversation + files to before the given turn. */
  rewind(turn: number): string[] {
    const s = this.session;
    const files = this.checkpoints.rewind(turn);
    const idx = s.turnIndex[turn];
    if (idx != null) s.messages = s.messages.slice(0, idx);
    for (const k of Object.keys(s.turnIndex)) if (+k >= turn) delete s.turnIndex[+k];
    s.turn = turn - 1; s.snapshots = this.checkpoints.snaps;
    return files;
  }
}

// ---------- permission helpers (exported for tests) ----------
const SHELL_META = /[;&|`$<>(){}\n\r\\]|\*\*/;
/** `bash:cmd` matches exactly; `bash:prefix *` matches the prefix only when the rest has no shell control characters,
 *  so an approved `npm *` cannot be chained into `npm test; curl … | sh`. */
export function bashRuleAllows(rules: string[], cmd: string): boolean {
  return rules.some((r) => {
    if (!r.startsWith("bash:")) return false;
    const body = r.slice(5);
    if (cmd === body) return true;
    if (!body.endsWith("*")) return false;
    const prefix = body.slice(0, -1);
    return cmd.startsWith(prefix) && !SHELL_META.test(cmd);
  });
}
const SECRETISH = /[A-Za-z0-9_\-]{32,}/;
/** Read-only tools still ask when they reach outside the project (e.g. ~/.ssh, credential files),
 *  and web_search asks when the query carries a long token-like string (possible exfiltration). */
export function needsReadApproval(tool: { name: string }, args: any, cwd: string): boolean {
  if (tool.name === "web_search") return SECRETISH.test(String(args?.query ?? ""));
  const p = args?.path; if (typeof p !== "string" || !p) return false;
  const full = path.resolve(cwd, p.replace(/^~(?=$|\/)/, os.homedir()));
  let real = full; try { real = fs.realpathSync(full); } catch {}
  let root = cwd; try { root = fs.realpathSync(cwd); } catch {}
  return !(real === root || real.startsWith(root + path.sep));
}
