import { runShell } from "./tools.js";
import { Settings } from "./config.js";

/** Hooks: shell commands run on events. Event payload is passed as JSON in $ATOM_HOOK_INPUT.
 *  PreToolUse hooks that exit with code 2 block the tool call (stdout is returned to the model as the reason). */
export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart";
export async function runHooks(s: Settings, ev: HookEvent, payload: any, cwd: string): Promise<{ blocked: boolean; output: string }> {
  const hs = s.hooks?.[ev] || [];
  let out = "", blocked = false;
  for (const h of hs) {
    if (h.matcher && payload.tool && !new RegExp(h.matcher).test(payload.tool)) continue;
    process.env.ATOM_HOOK_INPUT = JSON.stringify({ event: ev, ...payload });
    const r = await runShell(h.command, cwd, 30000);
    delete process.env.ATOM_HOOK_INPUT;
    out += r.out; if (r.code === 2) blocked = true;
  }
  return { blocked, output: out.trim() };
}
