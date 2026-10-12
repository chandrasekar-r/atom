import { Credentials } from "./config.js";

export interface ToolCall { id: string; name: string; arguments: string }
export interface Msg { role: "system" | "user" | "assistant" | "tool"; content: string | null | any[]; tool_calls?: any[]; tool_call_id?: string; name?: string }
export interface Usage { prompt: number; completion: number; neurons: number }
export interface ChatResult { content: string; reasoning: string; toolCalls: ToolCall[]; usage: Usage }

export function endpoint(c: Credentials): { url: string; headers: Record<string, string> } {
  if (c.kind === "gateway") return { url: c.url.replace(/\/$/, "") + "/v1/chat/completions", headers: { authorization: `Bearer ${c.key}` } };
  const tok = c.kind === "api_token" ? c.apiToken : c.accessToken;
  return { url: `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/ai/v1/chat/completions`, headers: { authorization: `Bearer ${tok}` } };
}

/** Some models (e.g. qwen2.5-coder) emit tool calls as text. Recover them. */
export function parseTextToolCalls(text: string, toolNames: string[]): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  let rest = text;
  const re = /<(tools?|tool_call)>\s*([\s\S]*?)\s*<\/\1>/g;
  let m: RegExpExecArray | null;
  const tryAdd = (s: string) => {
    try {
      const o = JSON.parse(s);
      const arr = Array.isArray(o) ? o : [o];
      for (const x of arr) if (x && toolNames.includes(x.name)) calls.push({ id: "t" + Math.random().toString(36).slice(2, 10), name: x.name, arguments: typeof x.arguments === "string" ? x.arguments : JSON.stringify(x.arguments ?? x.parameters ?? {}) });
      return true;
    } catch { return false; }
  };
  while ((m = re.exec(text))) if (tryAdd(m[2])) rest = rest.replace(m[0], "");
  if (!calls.length) { const t = text.trim(); if (t.startsWith("{") && t.endsWith("}") && /"name"\s*:/.test(t) && tryAdd(t)) rest = ""; }
  return { calls, rest: rest.trim() };
}

export async function chat(c: Credentials, model: string, messages: Msg[], tools: any[], onText?: (t: string) => void, onReasoning?: (t: string) => void, signal?: AbortSignal): Promise<ChatResult> {
  const ep = endpoint(c);
  const body: any = { model, messages, stream: true, max_tokens: 8192 };
  if (tools.length) body.tools = tools;
  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ep.url, { method: "POST", headers: { ...ep.headers, "content-type": "application/json" }, body: JSON.stringify(body), signal });
    if (res.ok || (res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  if (!res!.ok) throw new Error(`Workers AI ${res!.status}: ${(await res!.text()).slice(0, 400)}`);
  const usage: Usage = { prompt: 0, completion: 0, neurons: 0 };
  let content = "", reasoning = "";
  const calls: Record<number, ToolCall> = {};
  const native: ToolCall[] = [];
  const ct = res!.headers.get("content-type") || "";
  const handle = (o: any) => {
    if (o.usage) { usage.prompt += o.usage.prompt_tokens || 0; usage.completion += o.usage.completion_tokens || 0; usage.neurons += o.usage.neurons || 0; }
    const ch = o.choices?.[0];
    const d = ch?.delta || ch?.message;
    if (d) {
      const r = d.reasoning_content ?? d.reasoning; if (r) { reasoning += r; onReasoning?.(r); }
      if (d.content) { content += d.content; onText?.(d.content); }
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? Object.keys(calls).length;
        const cur = (calls[i] ||= { id: tc.id || `call_${i}`, name: "", arguments: "" });
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments);
      }
    } else if (typeof o.response === "string" || o.tool_calls) {
      // Workers AI native format
      if (o.response) { content += o.response; onText?.(o.response); }
      for (const tc of o.tool_calls || []) native.push({ id: tc.id || "n" + native.length, name: tc.name || tc.function?.name, arguments: JSON.stringify(tc.arguments ?? JSON.parse(tc.function?.arguments || "{}")) });
    }
  };
  if (ct.includes("event-stream") && res!.body) {
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res!.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { handle(JSON.parse(data)); } catch {}
      }
    }
  } else {
    const j: any = await res!.json(); handle(j.result ?? j);
  }
  let toolCalls = [...Object.values(calls).filter((t) => t.name), ...native];
  if (!toolCalls.length && tools.length && content) {
    const p = parseTextToolCalls(content, tools.map((t) => t.function.name));
    if (p.calls.length) { toolCalls = p.calls; content = p.rest; }
  }
  return { content, reasoning, toolCalls, usage };
}

/** Verify credentials by listing nothing but a cheap call. */
export async function verify(c: Credentials): Promise<string> {
  if (c.kind === "gateway") {
    const r = await fetch(c.url.replace(/\/$/, "") + "/health"); return r.ok ? "gateway reachable" : `gateway ${r.status}`;
  }
  const tok = c.kind === "api_token" ? c.apiToken : c.accessToken;
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.accountId}/ai/models/search?per_page=1`, { headers: { authorization: `Bearer ${tok}` } });
  const j: any = await r.json(); if (!j.success) throw new Error("Workers AI access denied: " + JSON.stringify(j.errors)); return "Workers AI access ok";
}
