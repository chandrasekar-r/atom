import fs from "node:fs";
import path from "node:path";
import { globToRegex } from "./tools.js";
import { listRepoFiles } from "./repoindex.js";
import { repoSymbols, symbolBody } from "./symbols.js";

/** Expand @-mentions in a prompt:
 *   @file  @file:10-40  @file:10  @dir/  @src/**\/*.ts (glob)  @#Symbol  (images are returned separately)
 *  Per-file cap 40 KB, total cap 150 KB. */
export const IMG_RE = /\.(png|jpe?g|gif|webp)$/i;
export interface Expanded { text: string; images: string[]; notes: string[]; files: string[] }
const FILE_CAP = 40_000, TOTAL_CAP = 150_000, GLOB_MAX = 25;

export function expandMentions(prompt: string, cwd: string): Expanded {
  const res: Expanded = { text: prompt, images: [], notes: [], files: [] };
  let total = 0, att = "";
  const add = (rel: string, body: string, range = "") => {
    if (total >= TOTAL_CAP) { res.notes.push(`skipped ${rel} (attachment budget full)`); return; }
    let b = body; if (b.length > FILE_CAP) b = b.slice(0, FILE_CAP) + `\n… [truncated: ${body.length} chars]`;
    if (total + b.length > TOTAL_CAP) b = b.slice(0, TOTAL_CAP - total) + "\n… [truncated: budget]";
    total += b.length; att += `\n\n<file path="${rel}"${range ? ` lines="${range}"` : ""}>\n${b}\n</file>`; res.files.push(path.resolve(cwd, rel));
    res.notes.push(`Read ${rel}${range ? `:${range}` : ""} (${b.split("\n").length} lines)`);
  };
  for (const m of prompt.matchAll(/(?:^|\s)@(\S+)/g)) {
    let tok = m[1].replace(/[,.;)]+$/, "");
    if (tok.startsWith("#")) {
      const name = tok.slice(1); const hits = repoSymbols(cwd).filter((s) => s.name === name).slice(0, 3);
      if (!hits.length) { res.notes.push(`no symbol ${name}`); continue; }
      for (const h of hits) add(`${h.file}`, symbolBody(cwd, h), `${h.line}-${h.line + symbolBody(cwd, h).split("\n").length - 1}`);
      continue;
    }
    const rm = tok.match(/^(.*?):(\d+)(?:-(\d+))?$/); let range: [number, number] | null = null;
    if (rm && fs.existsSync(path.resolve(cwd, rm[1]))) { tok = rm[1]; range = [+rm[2], +(rm[3] || rm[2])]; }
    const abs = path.resolve(cwd, tok);
    if (/[*?{]/.test(tok)) {
      const re = globToRegex(tok); const fs_ = listRepoFiles(cwd).filter((f) => re.test(f));
      if (!fs_.length) { res.notes.push(`no files match ${tok}`); continue; }
      for (const f of fs_.slice(0, GLOB_MAX)) { try { const b = fs.readFileSync(path.join(cwd, f), "utf8"); if (!b.includes("\u0000")) add(f, b); } catch {} }
      if (fs_.length > GLOB_MAX) res.notes.push(`${tok}: attached ${GLOB_MAX} of ${fs_.length} files`);
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const rel = path.relative(cwd, abs) || ".";
      const list = listRepoFiles(cwd).filter((f) => rel === "." || f.startsWith(rel + "/"));
      att += `\n\n<directory path="${rel}">\n${list.slice(0, 400).join("\n")}${list.length > 400 ? `\n… +${list.length - 400} more` : ""}\n</directory>`;
      res.notes.push(`Listed ${rel}/ (${list.length} files)`); continue;
    }
    if (IMG_RE.test(abs)) { const mime = abs.endsWith(".png") ? "image/png" : abs.endsWith(".gif") ? "image/gif" : abs.endsWith(".webp") ? "image/webp" : "image/jpeg"; res.images.push(`data:${mime};base64,${fs.readFileSync(abs).toString("base64")}`); res.notes.push(`Attached image ${tok}`); continue; }
    const body = fs.readFileSync(abs, "utf8"); if (body.includes("\u0000")) continue;
    if (range) add(tok, body.split("\n").slice(range[0] - 1, range[1]).join("\n"), `${range[0]}-${range[1]}`);
    else add(tok, body);
  }
  res.text = prompt + att; return res;
}
