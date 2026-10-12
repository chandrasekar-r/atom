// Minimal streaming-safe Markdown -> ANSI renderer. Re-rendered from the full text on every
// delta, so partially streamed blocks (open code fences, half lines) render sensibly.
const E = (n: string) => (s: string) => (process.env.NO_COLOR ? s : `\x1b[${n}m${s}\x1b[0m`);
export const st = { dim: E("2"), bold: E("1"), italic: E("3"), under: E("4"), cyan: E("36"), green: E("32"), red: E("31"), yellow: E("33"), magenta: E("35"), blue: E("34"), gray: E("90"), inv: E("7") };

export const visibleWidth = (s: string) => [...s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")].length;

/** Wrap one ANSI line to width (word-aware, ANSI-preserving). */
export function wrapLine(line: string, width: number): string[] {
  if (width < 10 || visibleWidth(line) <= width) return [line];
  const out: string[] = []; let cur = "", w = 0, active = "";
  const tokens = line.match(/\x1b\[[0-9;?]*[A-Za-z]|\s+|[^\s\x1b]+/g) || [];
  for (const t of tokens) {
    if (t.startsWith("\x1b")) { cur += t; active = t === "\x1b[0m" ? "" : active + t; continue; }
    let tw = [...t].length;
    if (w + tw > width) {
      if (/^\s+$/.test(t)) { out.push(cur + "\x1b[0m"); cur = active; w = 0; continue; }
      if (w > 0) { out.push(cur + "\x1b[0m"); cur = active; w = 0; }
      let chars = [...t];
      while (chars.length > width) { out.push(cur + chars.slice(0, width).join("") + "\x1b[0m"); cur = active; chars = chars.slice(width); }
      cur += chars.join(""); w = chars.length; continue;
    }
    cur += t; w += tw;
  }
  out.push(cur);
  return out;
}

function inline(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_, c) => st.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, c) => st.bold(c))
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, (_, p, c) => p + st.italic(c))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => st.under(st.blue(t)) + st.gray(` (${u})`));
}

export function renderMarkdown(md: string, width = 100): string[] {
  const out: string[] = [];
  let inCode = false, lang = "";
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = l.match(/^\s*```(\S*)/);
    if (fence) { if (!inCode) { inCode = true; lang = fence[1]; out.push(st.gray("╭─ " + (lang || "code"))); } else { inCode = false; out.push(st.gray("╰─")); } continue; }
    if (inCode) { out.push(st.gray("│ ") + (lang === "diff" ? (l.startsWith("+") ? st.green(l) : l.startsWith("-") ? st.red(l) : l) : st.yellow(l))); continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)/))) { out.push(st.bold(m[1].length <= 2 ? st.magenta(m[2]) : m[2])); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) { out.push(st.gray("─".repeat(Math.min(width, 40)))); continue; }
    if ((m = l.match(/^>\s?(.*)/))) { out.push(...wrapLine(st.gray("▎ ") + st.italic(inline(m[1])), width)); continue; }
    if ((m = l.match(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)/))) {
      const box = m[2] ? (m[2].includes("x") || m[2].includes("X") ? st.green("☑ ") : "☐ ") : "";
      out.push(...wrapLine(m[1] + st.cyan("• ") + box + inline(m[3]), width)); continue;
    }
    if ((m = l.match(/^(\s*)(\d+)[.)]\s+(.*)/))) { out.push(...wrapLine(m[1] + st.cyan(m[2] + ". ") + inline(m[3]), width)); continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) { if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) out.push(st.gray(l.trim().replace(/[^|]/g, "─").replace(/\|/g, "┼"))); else out.push(l.trim().slice(1, -1).split("|").map((c) => " " + inline(c.trim()) + " ").join(st.gray("│"))); continue; }
    out.push(...wrapLine(inline(l), width));
  }
  return out;
}
