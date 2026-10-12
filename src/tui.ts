// Terminal primitives for Atom's interactive mode.
//
// Output model: everything that is finished (answers, tool results) is printed once into the terminal's
// normal scrollback. Below it sits a small "live area" (streaming text, spinner, prompt box, menus, status
// line) that is redrawn in place. A redraw finds the first line that differs from the last frame, moves the
// cursor there, clears to the end of the screen and prints the rest. Each redraw is wrapped in the
// terminal's synchronized-update mode (DEC private mode 2026) so it appears atomically.
import { st, visibleWidth, wrapLine } from "./markdown.js";

export type Key = { name: string; seq: string; paste?: string };

const ESCAPES: [string, string][] = [
  ["\x1b[27;2;13~", "shift-enter"], ["\x1b[13;2u", "shift-enter"], ["\x1b[1;5D", "word-left"], ["\x1b[1;5C", "word-right"],
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"], ["\x1bOA", "up"], ["\x1bOB", "down"], ["\x1bOC", "right"], ["\x1bOD", "left"],
  ["\x1b[H", "home"], ["\x1b[F", "end"], ["\x1b[1~", "home"], ["\x1b[4~", "end"], ["\x1b[3~", "delete"], ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
  ["\x1b[Z", "shift-tab"], ["\x1b\r", "alt-enter"], ["\x1bb", "word-left"], ["\x1bf", "word-right"],
];
const CONTROL: Record<number, string> = { 13: "enter", 10: "ctrl-j", 9: "tab", 127: "backspace", 8: "backspace", 3: "ctrl-c", 4: "ctrl-d", 1: "home", 5: "end", 21: "ctrl-u", 11: "ctrl-k", 23: "ctrl-w", 22: "ctrl-v", 20: "ctrl-t", 12: "ctrl-l", 15: "ctrl-o", 18: "ctrl-r", 31: "ctrl-_" };
const PASTE_ON = "\x1b[200~", PASTE_OFF = "\x1b[201~";

/** Split a chunk of raw stdin into key events (bracketed paste is returned as a single event). */
export function parseKeys(input: string): Key[] {
  const out: Key[] = [];
  let rest = input;
  while (rest.length) {
    if (rest.startsWith(PASTE_ON)) {
      const close = rest.indexOf(PASTE_OFF);
      out.push({ name: "paste", seq: "", paste: rest.slice(PASTE_ON.length, close < 0 ? undefined : close) });
      rest = close < 0 ? "" : rest.slice(close + PASTE_OFF.length); continue;
    }
    const esc = ESCAPES.find(([seq]) => rest.startsWith(seq));
    if (esc) { out.push({ name: esc[1], seq: esc[0] }); rest = rest.slice(esc[0].length); continue; }
    if (rest[0] === "\x1b") {
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
      const seq = csi ? csi[0] : "\x1b";
      out.push({ name: csi ? "unknown" : "escape", seq }); rest = rest.slice(seq.length); continue;
    }
    const code = rest.codePointAt(0)!; const ch = String.fromCodePoint(code);
    out.push({ name: CONTROL[code] || "char", seq: ch }); rest = rest.slice(ch.length);
  }
  return out;
}

export class Screen {
  out = process.stdout;
  private shown: string[] = [];   // lines of the live area as last drawn
  private cursorLine = 0;         // line inside the live area where the terminal cursor was left
  get width() { return this.out.columns || 100; }
  get height() { return this.out.rows || 30; }

  private layout(lines: string[]): string[] {
    const w = this.width - 1;
    return lines.flatMap((l) => wrapLine(l, w)).map((l) => (visibleWidth(l) > w ? wrapLine(l, w)[0] : l));
  }
  private toTop(): string { return (this.cursorLine > 0 ? `\x1b[${this.cursorLine}A` : "") + "\r"; }

  /** Print finished lines above the live area, then redraw the live area below them. */
  commit(done: string[], live: string[], cursor?: [number, number]) {
    let buf = "\x1b[?2026h" + this.toTop() + "\x1b[J";
    for (const l of this.layout(done)) buf += l + "\r\n";
    this.out.write(buf + "\x1b[?2026l");
    this.shown = []; this.cursorLine = 0;
    this.render(live, cursor);
  }

  /** Redraw the live area, rewriting from the first changed line downwards. */
  render(input: string[], cursor?: [number, number]) {
    let lines = this.layout(input);
    let cur = cursor;
    const room = this.height - 1;
    if (lines.length > room) { const drop = lines.length - room; lines = lines.slice(drop); if (cur) cur = [cur[0] - drop, cur[1]]; }
    let first = 0;
    while (first < lines.length && first < this.shown.length && lines[first] === this.shown[first]) first++;
    let buf = "\x1b[?2026h\x1b[?25l" + this.toTop();
    if (first < lines.length || lines.length !== this.shown.length) {
      // step to the line above the first change (it exists), then newline so the terminal scrolls if needed
      if (first > 1) buf += `\x1b[${first - 1}B`;
      if (first > 0) buf += "\r\n";
      buf += "\r\x1b[J" + lines.slice(first).join("\r\n");
    } else if (lines.length) buf += lines.length > 1 ? `\x1b[${lines.length - 1}B` : "";
    // the cursor is now on the last line of the live area
    const last = Math.max(0, lines.length - 1);
    const [row, col] = cur && cur[0] >= 0 ? cur : [last, 0];
    if (row < last) buf += `\x1b[${last - row}A`;
    buf += "\r" + (col > 0 ? `\x1b[${col}C` : "") + (cur ? "\x1b[?25h" : "") + "\x1b[?2026l";
    this.out.write(buf);
    this.shown = lines; this.cursorLine = row;
  }

  /** Remove the live area (used before exiting). */
  clear() { this.out.write(this.toTop() + "\x1b[J\x1b[?25h"); this.shown = []; this.cursorLine = 0; }
}

/** Fuzzy match score (smaller is better), or -1 when `q` is not a subsequence of `s`. */
export function fuzzy(q: string, s: string): number {
  if (!q) return 0;
  const needle = q.toLowerCase(), hay = s.toLowerCase();
  const at = hay.indexOf(needle);
  if (at >= 0) { const bonus = hay.endsWith(needle) || hay.includes("/" + needle) ? 5 : 0; return at + hay.length / 100 - bonus; }
  let spread = 0, prev = -1, k = 0;
  for (let i = 0; i < hay.length && k < needle.length; i++) {
    if (hay[i] !== needle[k]) continue;
    if (prev >= 0) spread += i - prev - 1;
    prev = i; k++;
  }
  return k < needle.length ? -1 : 100 + spread + hay.length / 100;
}

export interface Suggestion { value: string; label: string; hint?: string }
type Completer = (text: string, pos: number) => { items: Suggestion[]; start: number } | null;

/** The prompt box: multi-line text with a caret, input history and a completion menu. */
export class Editor {
  text = ""; pos = 0;
  history: string[] = [];
  sugg: Suggestion[] = []; sIdx = 0;
  private browsing = -1;      // index into history while browsing with ↑/↓ (-1 = editing a fresh draft)
  private saved = "";         // the draft that was being typed before browsing started
  constructor(public complete: Completer) {}

  private caret(): { row: number; col: number } {
    const upto = this.text.slice(0, this.pos); const nl = upto.lastIndexOf("\n");
    return { row: (upto.match(/\n/g) || []).length, col: [...upto.slice(nl + 1)].length };
  }
  private replace(from: number, to: number, s: string) { this.text = this.text.slice(0, from) + s + this.text.slice(to); this.pos = from + s.length; this.refresh(); }
  insert(s: string) { this.replace(this.pos, this.pos, s); }
  set(t: string) { this.text = t; this.pos = t.length; this.refresh(); }
  refresh() { const r = this.complete(this.text, this.pos); this.sugg = r ? r.items.slice(0, 8) : []; if (this.sIdx >= this.sugg.length) this.sIdx = 0; }
  acceptSuggestion(): boolean {
    const r = this.complete(this.text, this.pos); const pick = this.sugg[this.sIdx];
    if (!r || !pick) return false;
    this.replace(r.start, this.pos, pick.value); this.sugg = []; this.refresh(); return true;
  }
  pushHistory(t: string) { if (t.trim() && this.history.at(-1) !== t) this.history.push(t); this.browsing = -1; }
  private recall(dir: 1 | -1) {
    const next = this.browsing + dir;
    if (next >= this.history.length || next < -1) return;
    if (this.browsing === -1) this.saved = this.text;
    this.browsing = next;
    this.text = next === -1 ? this.saved : this.history[this.history.length - 1 - next];
    this.pos = this.text.length; this.sugg = [];
  }
  private lineStart(p = this.pos) { return this.text.lastIndexOf("\n", p - 1) + 1; }
  private lineEnd(p = this.pos) { const e = this.text.indexOf("\n", p); return e < 0 ? this.text.length : e; }
  private verticalMove(dir: 1 | -1) {
    const { col } = this.caret();
    const target = dir < 0 ? this.lineStart(this.lineStart() - 1) : this.lineEnd() + 1;
    const len = this.lineEnd(target) - target;
    this.pos = target + Math.min(col, len);
  }

  /** Apply a key; "submit" means Enter should send the text. */
  key(k: Key): "submit" | "handled" | "ignored" {
    const { row } = this.caret(); const rows = this.text.split("\n").length;
    const menu = this.sugg.length > 0;
    switch (k.name) {
      case "char": this.insert(k.seq); break;
      case "paste": this.insert((k.paste || "").replace(/\r\n?/g, "\n")); break;
      case "enter":
        if (menu && this.acceptSuggestion()) return this.text.startsWith("/") && !this.text.includes(" ") ? "submit" : "handled";
        if (this.pos > 0 && this.text[this.pos - 1] === "\\") { this.replace(this.pos - 1, this.pos, "\n"); break; }
        return "submit";
      case "shift-enter": case "alt-enter": case "ctrl-j": this.insert("\n"); break;
      case "tab": if (!menu) return "ignored"; this.acceptSuggestion(); break;
      case "backspace": if (this.pos > 0) { const before = [...this.text.slice(0, this.pos)]; const gone = before.pop()!; this.replace(this.pos - gone.length, this.pos, ""); } break;
      case "delete": if (this.pos < this.text.length) this.replace(this.pos, this.pos + 1, ""); break;
      case "left": this.pos = Math.max(0, this.pos - 1); break;
      case "right": this.pos = Math.min(this.text.length, this.pos + 1); break;
      case "word-left": { const m = /\S+\s*$/.exec(this.text.slice(0, this.pos)); this.pos = m ? this.pos - m[0].length : Math.max(0, this.pos - 1); break; }
      case "word-right": { const m = /^\s*\S+/.exec(this.text.slice(this.pos)); if (m) this.pos += m[0].length; break; }
      case "home": this.pos = this.lineStart(); break;
      case "end": this.pos = this.lineEnd(); break;
      case "ctrl-u": this.replace(this.lineStart(), this.pos, ""); break;
      case "ctrl-k": this.replace(this.pos, this.lineEnd(), ""); break;
      case "ctrl-w": { const m = /(\S+\s*|\s+)$/.exec(this.text.slice(0, this.pos)); if (m) this.replace(this.pos - m[0].length, this.pos, ""); break; }
      case "up": if (menu) this.sIdx = (this.sIdx + this.sugg.length - 1) % this.sugg.length; else if (row > 0) this.verticalMove(-1); else this.recall(1); break;
      case "down": if (menu) this.sIdx = (this.sIdx + 1) % this.sugg.length; else if (row < rows - 1) this.verticalMove(1); else this.recall(-1); break;
      default: return "ignored";
    }
    return "handled";
  }

  /** Draw the prompt box (and the completion menu under it). `cursor` is [line, column] within `lines`. */
  render(width: number, prompt = "> ", placeholder = ""): { lines: string[]; cursor: [number, number] } {
    const usable = Math.max(4, width - 4 - prompt.length);
    const indent = " ".repeat(prompt.length);
    const { row: caretRow, col: caretCol } = this.caret();
    const lines = [st.gray("╭" + "─".repeat(width - 3) + "╮")];
    let cursor: [number, number] = [1, 2 + prompt.length];
    this.text.split("\n").forEach((src, r) => {
      const cps = [...src];
      const pieces = Math.max(1, Math.ceil(cps.length / usable) + (r === caretRow && caretCol === cps.length && cps.length > 0 && cps.length % usable === 0 ? 1 : 0));
      for (let p = 0; p < pieces; p++) {
        const piece = cps.slice(p * usable, (p + 1) * usable).join("");
        const shown = !this.text && placeholder ? st.gray(placeholder) : piece;
        const lead = r === 0 && p === 0 ? st.bold(prompt) : indent;
        lines.push(st.gray("│ ") + lead + shown + " ".repeat(Math.max(0, usable - visibleWidth(shown))) + st.gray("│"));
        const inPiece = caretCol >= p * usable && (caretCol < (p + 1) * usable || p === pieces - 1);
        if (r === caretRow && inPiece) cursor = [lines.length - 1, 2 + prompt.length + caretCol - p * usable];
      }
    });
    lines.push(st.gray("╰" + "─".repeat(width - 3) + "╯"));
    this.sugg.forEach((s, i) => {
      const head = i === this.sIdx ? st.cyan("❯ " + s.label) : "  " + s.label;
      lines.push(head + (s.hint ? "  " + st.gray(s.hint.slice(0, Math.max(0, width - s.label.length - 8))) : ""));
    });
    return { lines, cursor };
  }
}

export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
