// Interactive terminal mode built on tui.ts.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Agent, Decision, Mode, UI, CONTEXT_TOKENS } from "./agent.js";
import { Tool, walk } from "./tools.js";
import { colorDiff } from "./diff.js";
import { renderMarkdown, st } from "./markdown.js";
import { MODELS } from "./config.js";
import { expandMentions } from "./mentions.js";
import { repoSymbols } from "./symbols.js";
import { Editor, Key, parseKeys, Screen, SPIN, Suggestion, fuzzy } from "./tui.js";

export interface TuiDeps {
  agent: Agent; cwd: string; version: string;
  commands: () => { name: string; hint: string }[];
  /** Runs a slash command; output goes through say(). */
  slash: (line: string) => Promise<void>;
  shell: (cmd: string) => Promise<string>;
  onExit: () => void;
  banner: string[];
  onTurnEnd?: () => void;
  /** Persistent footer note (e.g. "update available"). */
  footerNote?: () => string;
}
const MODES: Mode[] = ["ask", "auto", "plan", "bypass"];
const MODE_LABEL: Record<Mode, string> = { ask: "", auto: st.magenta("⏵⏵ accept edits on"), plan: st.cyan("⏸ plan mode on"), bypass: st.red("⏵⏵ bypass permissions on") };
const VERBS = ["Thinking", "Working", "Pondering", "Tinkering", "Computing", "Reticulating", "Brewing", "Forging"];
const fmtK = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;

export function readClipboardImage(): Buffer | null {
  const tries: [string, string[]][] = process.platform === "darwin"
    ? [["pngpaste", ["-"]], ["osascript", ["-e", "set f to (POSIX path of (path to temporary items)) & \"atom-clip.png\"", "-e", "set d to the clipboard as «class PNGf»", "-e", "set h to open for access POSIX file f with write permission", "-e", "write d to h", "-e", "close access h", "-e", "return f"]]]
    : [["wl-paste", ["--no-newline", "--type", "image/png"]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]]];
  for (const [cmd, args] of tries) {
    try {
      const out = execFileSync(cmd, args, { stdio: ["ignore", "pipe", "ignore"], timeout: 3000, maxBuffer: 50e6 });
      if (cmd === "osascript") { const f = out.toString().trim(); if (fs.existsSync(f)) return fs.readFileSync(f); continue; }
      if (out.length > 8 && out[0] === 0x89) return out;
    } catch {}
  }
  return null;
}
export const dataUrl = (buf: Buffer, file = "x.png") => `data:image/${(path.extname(file).slice(1) || "png").replace("jpg", "jpeg")};base64,${buf.toString("base64")}`;

export async function runTui(d: TuiDeps, initial?: string) {
  const { agent, cwd } = d;
  const scr = new Screen();
  let files: string[] = []; let filesAt = 0;
  const fileList = () => { if (Date.now() - filesAt > 10000) { files = walk(cwd, cwd, [], 20000); filesAt = Date.now(); } return files; };
  const complete = (text: string, pos: number): { items: Suggestion[]; start: number } | null => {
    const before = text.slice(0, pos);
    if (/^\/\S*$/.test(before)) {
      const q = before.slice(1);
      const items = d.commands().map((c) => ({ c, s: c.name.startsWith(q) ? 0 : fuzzy(q, c.name) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s)
        .map(({ c }) => ({ value: "/" + c.name, label: "/" + c.name, hint: c.hint }));
      return items.length && !(items.length === 1 && items[0].value === before) ? { items, start: 0 } : null;
    }
    const mm = before.match(/^\/model\s+(\S*)$/);
    if (mm) {
      const q = mm[1].toLowerCase(); const items = Object.entries(MODELS).map(([k, v]) => ({ k, v, s: k.startsWith(q) ? 0 : fuzzy(q, k) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s)
        .map(({ k, v }) => ({ value: "/model " + k, label: k, hint: v === agent.session.model ? "● current" : v }));
      return items.length && !(items.length === 1 && items[0].value === before) ? { items, start: 0 } : null;
    }
    const sm = before.match(/(^|\s)@#(\w*)$/);
    if (sm) {
      const q = sm[2]; const items = repoSymbols(cwd).map((x) => ({ x, s: x.name.startsWith(q) ? 0 : fuzzy(q, x.name) })).filter((y) => y.s >= 0).sort((a, b) => a.s - b.s).slice(0, 8)
        .map(({ x }) => ({ value: "@#" + x.name + " ", label: "@#" + x.name, hint: `${x.file}:${x.line}` }));
      return items.length ? { items, start: pos - q.length - 2 } : null;
    }
    const m = before.match(/(^|\s)@(\S*)$/);
    if (m) {
      const q = m[2]; const dirs = [...new Set(fileList().map((f) => path.dirname(f)).filter((x) => x !== "."))].map((x) => x + "/");
      const items = [...dirs, ...fileList()].map((f) => ({ f, s: fuzzy(q, f) })).filter((x) => x.s >= 0).sort((a, b) => a.s - b.s).slice(0, 8)
        .map(({ f }) => ({ value: "@" + f + (f.endsWith("/") ? "" : " "), label: "@" + f }));
      return items.length ? { items, start: pos - q.length - 1 } : null;
    }
    return null;
  };
  const ed = new Editor(complete);
  try { ed.history = JSON.parse(fs.readFileSync(path.join(process.env.ATOM_CONFIG_DIR || path.join(process.env.HOME || "", ".config", "atom"), "history.json"), "utf8")).slice(-200); } catch {}
  const saveHistory = () => { try { fs.writeFileSync(path.join(process.env.ATOM_CONFIG_DIR || path.join(process.env.HOME || "", ".config", "atom"), "history.json"), JSON.stringify(ed.history.slice(-200))); } catch {} };

  // ---- state
  let running = false, started = 0, baseTok = 0, verb = VERBS[0], spin = 0;
  let stream = "", think = "", showThinking = false, streamTokens = 0;
  let pendingTools: { name: string; sum: string }[] = [];
  let todos: { content: string; status: string }[] = [];
  let images: { url: string; name: string }[] = [];
  let queue: string[] = [];
  let modal: null | { kind: "ask"; title: string; body: string[]; options: string[]; idx: number; resolve: (i: number) => void }
    | { kind: "select"; title: string; items: string[]; idx: number; resolve: (i: number) => void }
    | { kind: "question"; prompt: string; resolve: (s: string) => void } = null;
  let ctrlC = 0, lastEsc = 0, notice = "";
  const width = () => Math.max(40, scr.width);

  const renderThink = () => {
    if (!think) return [];
    if (!showThinking) return [st.gray(st.italic(`✻ Thinking… (${fmtK(Math.round(think.length / 4))} tokens · ctrl+t to show)`))];
    return renderMarkdown(think, width() - 4).map((l) => st.gray(st.italic("  " + l)));
  };
  const live = (): { lines: string[]; cursor?: [number, number] } => {
    const L: string[] = [];
    L.push(...renderThink());
    if (stream) L.push(...renderMarkdown(stream, width() - 4).map((l, i) => (i === 0 ? "⏺ " : "  ") + l));
    for (const pt of pendingTools) L.push(st.cyan(`${SPIN[spin % SPIN.length]} ${pt.name}`) + st.gray(`(${pt.sum.slice(0, width() - pt.name.length - 8)})`));
    if (running && todos.length) L.push(...todoLines(todos).map((l) => "  " + l));
    if (running) {
      const secs = Math.round((Date.now() - started) / 1000);
      const tok = agent.session.usage.completion - baseTok + streamTokens;
      L.push(st.magenta(`${SPIN[spin % SPIN.length]} ${verb}…`) + st.gray(` (${secs}s · ↓ ${fmtK(tok)} tokens · esc to interrupt)`));
    }
    if (queue.length) L.push(...queue.map((q) => st.gray("  ⏎ queued: " + q.slice(0, 60))));
    L.push("");
    if (modal?.kind === "ask") {
      L.push(st.yellow("╭─ " + modal.title));
      for (const b of modal.body) L.push(st.yellow("│ ") + b);
      modal.options.forEach((o, i) => L.push(st.yellow("│ ") + (i === (modal as any).idx ? st.cyan(`❯ ${i + 1}. ${o}`) : `  ${i + 1}. ${o}`)));
      L.push(st.yellow("╰─ ") + st.gray("↑↓ to select · enter to confirm · esc to deny"));
      return { lines: L };
    }
    if (modal?.kind === "select") {
      L.push(st.bold(modal.title));
      const n = Math.min(12, modal.items.length); const startI = Math.max(0, Math.min(modal.idx - 5, modal.items.length - n));
      for (let i = startI; i < startI + n; i++) L.push(i === modal.idx ? st.cyan("❯ " + modal.items[i]) : "  " + modal.items[i]);
      L.push(st.gray("↑↓ select · enter confirm · esc cancel"));
      return { lines: L };
    }
    const prompt = modal?.kind === "question" ? modal.prompt + " " : ed.text.startsWith("!") ? "! " : "> ";
    const e = ed.render(width(), prompt, modal ? "" : running ? "Type to queue a message…" : "Try \"explain this repo\", @file, /command, !shell");
    const base = L.length; L.push(...e.lines);
    const footerL = notice || MODE_LABEL[agent.mode] + (agent.mode === "ask" ? st.gray("? shortcuts · shift+tab to cycle modes") : st.gray(" (shift+tab to cycle)"));
    const pct = Math.min(100, Math.round((agent.lastPrompt / CONTEXT_TOKENS) * 100));
    const right = (d.footerNote?.() ? st.yellow(d.footerNote()) + " " : "") + st.gray(`${images.length ? `[${images.length} image${images.length > 1 ? "s" : ""}] ` : ""}${agent.session.model.split("/").pop()} · ctx ${pct}%`);
    if (ed.sugg.length === 0) L.push(" " + footerL + "   " + right);
    return { lines: L, cursor: [base + e.cursor[0], e.cursor[1]] };
  };
  // wrapping can shift rows: the editor box lines are exactly width-1 wide so they never wrap.
  const draw = () => { const v = live(); scr.render(v.lines, v.cursor); };
  const commit = (lines: string[]) => { const v = live(); scr.commit(lines, v.lines, v.cursor); };
  const say = (s: string) => commit(s.split("\n"));

  const flushStream = (all = true) => {
    if (think && !showThinking) commit([st.gray(st.italic(`✻ Thought for ${fmtK(Math.round(think.length / 4))} tokens`))]);
    else if (think) commit(renderThink());
    think = "";
    if (!stream) return;
    let text = stream;
    if (!all) {
      // commit completed paragraphs outside code fences, keep the tail live
      let cut = -1, inCode = false, idx = 0;
      for (const line of stream.split("\n")) { if (/^\s*```/.test(line)) inCode = !inCode; idx += line.length + 1; if (!inCode && line.trim() === "" && idx < stream.length) cut = idx; }
      if (cut < 0) return; text = stream.slice(0, cut); stream = stream.slice(cut);
    } else stream = "";
    const md = renderMarkdown(text.replace(/\n+$/, ""), width() - 4);
    commit(md.map((l, i) => (i === 0 && !committedPrefix ? "⏺ " : "  ") + l));
    committedPrefix = !all;
  };
  let committedPrefix = false;

  const ui: UI = {
    text: (t) => { if (think) flushStream(); stream += t; streamTokens += Math.max(1, Math.round(t.length / 4)); if (renderMarkdown(stream, width()).length > scr.height / 2) flushStream(false); draw(); },
    reasoning: (t) => { think += t; streamTokens += Math.max(1, Math.round(t.length / 4)); draw(); },
    toolStart: (name, sum) => { flushStream(); committedPrefix = false; pendingTools.push({ name, sum }); draw(); },
    toolEnd: (name, res, ok) => {
      let idx = -1; for (let i = pendingTools.length - 1; i >= 0; i--) if (pendingTools[i].name === name) { idx = i; break; }
      const sum = idx >= 0 ? pendingTools.splice(idx, 1)[0].sum : "";
      const head = (ok ? st.green("⏺ ") : st.red("⏺ ")) + st.bold(name.replace(/^\s*↳\s*/, (m) => m)) + st.gray(`(${sum.slice(0, width() - name.length - 6)})`);
      let body: string[];
      const lines = res.split("\n");
      if (name === "todo_write" && ok) body = todoLines(todos);
      else if ((name === "edit_file" || name === "write_file") && ok) body = [lines[0], ...colorDiff(lines.slice(1, 60).join("\n")).split("\n").filter((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim() !== "")].concat(lines.length > 61 ? [st.gray(`… +${lines.length - 61} lines`)] : []);
      else if (name.includes("↳")) body = [st.gray(lines[0].slice(0, 100))];
      else body = lines.slice(0, 5).map((l) => st.gray(l.slice(0, 300))).concat(lines.length > 5 ? [st.gray(`… +${lines.length - 5} lines`)] : []);
      commit([head, ...body.map((l, i) => (i === 0 ? "  ⎿  " : "     ") + (ok ? l : st.red(l)))]);
      verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    },
    ask: (tool, preview) => new Promise<Decision>((resolve) => {
      flushStream();
      const body = (tool.name === "bash" ? preview.split("\n").map((l) => st.bold(l)) : colorDiff(preview).split("\n")).slice(0, Math.max(6, scr.height - 14));
      const rule = tool.name === "bash" ? `bash:${String(preview.replace(/^\$ /, "")).split(" ")[0]} *` : tool.name;
      modal = { kind: "ask", title: `Allow ${tool.name}?`, body, idx: 0, options: ["Yes", `Yes, and don't ask again (${rule}) for this project`, "No, and tell Atom what to do differently (esc)"], resolve: (i) => resolve((["yes", "always", "no"] as Decision[])[i]) };
      draw();
    }),
    info: (t) => { flushStream(); say(t); },
    todos: (l) => { todos = l; draw(); },
    usage: () => { streamTokens = 0; },
    compacting: () => { flushStream(); say(st.gray("✻ Context is getting full: auto-compacting the conversation…")); },
  };
  agent.ui = ui;

  const select = (title: string, items: string[], idx = 0) => new Promise<number>((resolve) => { modal = { kind: "select", title, items, idx, resolve }; draw(); });
  const question = (prompt: string) => new Promise<string>((resolve) => { ed.set(""); modal = { kind: "question", prompt, resolve }; draw(); });

  const runTurn = async (text: string) => {
    const imgs = images.map((i) => i.url); images = [];
    // @file, @file:10-40, @dir/, @glob, @#Symbol, @image.png
    const ex = expandMentions(text, cwd); imgs.push(...ex.images); ex.files.forEach((f) => agent.readFiles.add(f));
    if (ex.notes.length) commit(ex.notes.map((n) => st.gray(`  ⎿  ${n}`)));
    text = ex.text;
    running = true; started = Date.now(); streamTokens = 0; baseTok = agent.session.usage.completion; todos = []; verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    const timer = setInterval(() => { spin++; draw(); }, 100);
    try { await agent.run(text, imgs); } catch (e: any) { if (e.name !== "AbortError") { flushStream(); say(st.red("Error: " + e.message)); } }
    clearInterval(timer); flushStream(); committedPrefix = false; pendingTools = []; running = false; d.onTurnEnd?.(); draw();
    const next = queue.shift(); if (next) await submit(next);
  };

  const submit = async (raw: string) => {
    const text = raw.trim(); if (!text && !images.length) return;
    ed.pushHistory(raw); saveHistory();
    commit(["", ...raw.split("\n").map((l, i) => st.gray(i === 0 ? "> " : "  ") + l)]);
    if (text.startsWith("/")) {
      const name = text.slice(1).split(" ")[0];
      if (name === "tree") { await treeCmd(); return; }
      if (name === "exit" || name === "quit") { quit(); return; }
      await d.slash(text); draw(); return;
    }
    if (text.startsWith("!")) { const out = await d.shell(text.slice(1)); say(st.gray(out.trimEnd().split("\n").slice(0, 40).join("\n"))); return; }
    if (text.startsWith("#")) { const f = path.join(cwd, "ATOM.md"); fs.appendFileSync(f, (fs.existsSync(f) ? "\n" : "") + "- " + text.slice(1).trim() + "\n"); say(st.green(`Saved to ATOM.md (loaded next session)`)); agent.memory += "\n- " + text.slice(1).trim(); return; }
    await runTurn(text);
  };

  const treeCmd = async () => {
    const { historyOutline, rewindTo } = await import("./session.js");
    const rows = historyOutline(agent.session as any);
    if (!rows.length) { say(st.gray("No messages yet.")); return; }
    const items = rows.map((r) => "  ".repeat(r.depth) + (r.active ? st.green("● ") : "○ ") + r.label);
    const i = await select("Session tree: pick a user message to branch from (its text is put back in the editor)", items, rows.length - 1);
    if (i < 0) return;
    ed.set(rewindTo(agent.session as any, rows[i].id));
    say(st.green(`Branched: active path now has ${agent.session.messages.length} messages. Edit and press enter to continue on a new branch.`));
  };

  const quit = () => { scr.clear(); process.stdin.setRawMode?.(false); d.onExit(); process.exit(0); };

  const onKey = async (k: Key) => {
    if (k.name !== "ctrl-c") ctrlC = 0;
    if (notice && k.name !== "ctrl-c") notice = "";
    if (modal?.kind === "ask" || modal?.kind === "select") {
      const n = modal.kind === "ask" ? modal.options.length : modal.items.length;
      if (k.name === "up") modal.idx = (modal.idx - 1 + n) % n;
      else if (k.name === "down" || k.name === "tab") modal.idx = (modal.idx + 1) % n;
      else if (k.name === "char" && /[1-9]/.test(k.seq) && +k.seq <= n && modal.kind === "ask") { const m = modal; modal = null; m.resolve(+k.seq - 1); }
      else if (k.name === "enter") { const m = modal; modal = null; m.resolve(m.idx); }
      else if (k.name === "escape" || k.name === "ctrl-c") { const m = modal; modal = null; m.resolve(m.kind === "ask" ? 2 : -1); }
      draw(); return;
    }
    switch (k.name) {
      case "escape":
        if (running) { agent.abort?.abort(); flushStream(); say(st.red("  ⎿  Interrupted by user")); return; }
        if (ed.sugg.length) { ed.sugg = []; draw(); return; }
        if (Date.now() - lastEsc < 500 && !ed.text) { lastEsc = 0; await treeCmd(); return; }
        if (ed.text && Date.now() - lastEsc < 500) { ed.set(""); lastEsc = 0; draw(); return; }
        lastEsc = Date.now(); notice = st.gray(ed.text ? "Esc again to clear" : "Esc again for the session tree"); draw();
        return;
      case "ctrl-c":
        if (running) { agent.abort?.abort(); flushStream(); say(st.red("  ⎿  Interrupted by user")); return; }
        if (modal?.kind === "question") { const m = modal; modal = null; m.resolve(""); draw(); return; }
        if (ed.text) { ed.set(""); draw(); return; }
        if (++ctrlC >= 2) quit(); notice = st.gray("Press Ctrl+C again to exit"); draw(); return;
      case "ctrl-d": if (!ed.text) quit(); return;
      case "shift-tab": agent.mode = MODES[(MODES.indexOf(agent.mode) + 1) % MODES.length]; draw(); return;
      case "ctrl-t": showThinking = !showThinking; draw(); return;
      case "ctrl-l": scr.out.write("\x1b[2J\x1b[H"); scr.clear(); draw(); return;
      case "ctrl-v": {
        const buf = readClipboardImage();
        if (buf) { images.push({ url: dataUrl(buf), name: `image ${images.length + 1}` }); ed.insert(`[image #${images.length}] `); }
        else { notice = st.yellow("No image on the clipboard (needs pngpaste/osascript on macOS, wl-paste or xclip on Linux)"); }
        draw(); return;
      }
      case "paste": {
        const p = (k.paste || "").trim().replace(/^['"]|['"]$/g, "");
        if (IMG_RE.test(p) && fs.existsSync(p)) { images.push({ url: dataUrl(fs.readFileSync(p), p), name: path.basename(p) }); ed.insert(`[image #${images.length}: ${path.basename(p)}] `); draw(); return; }
        break;
      }
      case "char": if (k.seq === "?" && !ed.text && !modal) { say(SHORTCUTS); return; } break;
    }
    const r = ed.key(k);
    if (r === "submit") {
      const text = ed.text; ed.set("");
      if (modal?.kind === "question") { const m = modal; modal = null; commit([st.gray(m.prompt + " ") + text]); m.resolve(text); draw(); return; }
      if (running) { if (text.trim()) queue.push(text); draw(); return; }
      draw(); await submit(text); return;
    }
    draw();
  };

  // ---- start
  process.stdin.setRawMode?.(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  scr.out.write("\x1b[?2004h"); // bracketed paste
  process.on("exit", () => { scr.out.write("\x1b[?2004l\x1b[?25h"); });
  process.stdout.on("resize", () => { scr.clear(); draw(); });
  let chain = Promise.resolve();
  process.stdin.on("data", (data: string) => {
    for (const k of parseKeys(data)) {
      // Esc / Ctrl+C / modal keys must work while a turn is running, so don't serialize them behind it
      if (running || modal) { void onKey(k); continue; }
      chain = chain.then(() => onKey(k)).catch((e) => say(st.red(String(e))));
    }
  });
  commit(d.banner);
  draw();
  return { say, question, select, submit: (t: string) => submit(t) , ready: initial ? submit(initial) : Promise.resolve() };
}

export function todoLines(todos: { content: string; status: string }[]): string[] {
  return todos.map((t) => t.status === "completed" ? st.green("☒ ") + st.gray("\x1b[9m" + t.content + "\x1b[0m") : t.status === "in_progress" ? st.yellow("◼ ") + st.bold(t.content) : "☐ " + t.content);
}

const SHORTCUTS = [
  st.bold("Shortcuts"),
  "  /            commands (autocomplete)     @           fuzzy file mention",
  "  !            run a shell command         #           add a line to ATOM.md memory",
  "  shift+tab    cycle ask/auto/plan/bypass  esc         interrupt the agent",
  "  esc esc      session tree / branch       ctrl+t      show/hide thinking",
  "  \\⏎ or alt+⏎  newline (shift+⏎ in kitty)  ↑/↓         history",
  "  ctrl+v       paste image from clipboard  ctrl+c ×2   exit",
].join("\n");
