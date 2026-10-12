import { spawn, ChildProcess } from "node:child_process";
import { Tool } from "./tools.js";

/** MCP client. Transports: stdio (newline JSON-RPC), Streamable HTTP (POST, JSON or SSE replies, Mcp-Session-Id),
 *  and legacy HTTP+SSE (GET stream announces a POST endpoint). Supports tools/list, tools/call, resources/list. */
export interface McpServerConfig { command?: string; args?: string[]; env?: Record<string, string>; url?: string; type?: "stdio" | "http" | "sse"; headers?: Record<string, string>; disabled?: boolean }
type Pending = Map<number, (v: any) => void>;

export class McpClient {
  id = 0; pending: Pending = new Map(); proc?: ChildProcess; buf = ""; sessionId?: string; postUrl?: string; sseAbort?: AbortController;
  transport: "stdio" | "http" | "sse";
  constructor(public name: string, public cfg: McpServerConfig) {
    this.transport = cfg.type || (cfg.url ? (/\/sse\/?$/.test(cfg.url) ? "sse" : "http") : "stdio");
  }
  private onMessage(m: any) { if (m && m.id != null && this.pending.has(m.id)) { this.pending.get(m.id)!(m); this.pending.delete(m.id); } }
  private startStdio() {
    this.proc = spawn(this.cfg.command!, this.cfg.args || [], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...(this.cfg.env || {}) } });
    this.proc.stdout!.on("data", (d) => { this.buf += d.toString(); let nl; while ((nl = this.buf.indexOf("\n")) >= 0) { const line = this.buf.slice(0, nl); this.buf = this.buf.slice(nl + 1); try { this.onMessage(JSON.parse(line)); } catch {} } });
  }
  private async readSse(body: ReadableStream<Uint8Array>, onEvent: (ev: string, data: string) => void) {
    const dec = new TextDecoder(); let buf = "", ev = "message", data: string[] = [];
    for await (const ch of body as any) {
      buf += dec.decode(ch, { stream: true }); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, ""); buf = buf.slice(nl + 1);
        if (line === "") { if (data.length) onEvent(ev, data.join("\n")); ev = "message"; data = []; }
        else if (line.startsWith("event:")) ev = line.slice(6).trim(); else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }
  private async startSse() {
    this.sseAbort = new AbortController();
    const res = await fetch(this.cfg.url!, { headers: { accept: "text/event-stream", ...(this.cfg.headers || {}) }, signal: this.sseAbort.signal });
    if (!res.ok || !res.body) throw new Error(`SSE connect ${res.status}`);
    let ready: (v?: unknown) => void; const got = new Promise((r) => (ready = r));
    this.readSse(res.body, (ev, data) => { if (ev === "endpoint") { this.postUrl = new URL(data, this.cfg.url).href; ready(); } else { try { this.onMessage(JSON.parse(data)); } catch {} } }).catch(() => {});
    await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error("SSE: no endpoint event")), 15000))]);
  }
  private async send(msg: any): Promise<void> {
    if (this.transport === "stdio") { this.proc!.stdin!.write(JSON.stringify(msg) + "\n"); return; }
    const url = this.transport === "sse" ? this.postUrl! : this.cfg.url!;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}), ...(this.cfg.headers || {}) }, body: JSON.stringify(msg) });
    const sid = res.headers.get("mcp-session-id"); if (sid) this.sessionId = sid;
    if (this.transport === "sse") return; // replies come over the GET stream
    if (!res.ok) { const t = await res.text(); if (msg.id != null) this.onMessage({ id: msg.id, error: { message: `HTTP ${res.status}: ${t.slice(0, 200)}` } }); return; }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/event-stream") && res.body) await this.readSse(res.body, (_e, d) => { try { const m = JSON.parse(d); (Array.isArray(m) ? m : [m]).forEach((x) => this.onMessage(x)); } catch {} });
    else if (ct.includes("json")) { const m = await res.json(); (Array.isArray(m) ? m : [m]).forEach((x: any) => this.onMessage(x)); }
  }
  request(method: string, params: any = {}, timeout = 30000): Promise<any> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`MCP ${this.name} ${method} timed out`)); }, timeout);
      this.pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => { clearTimeout(t); this.pending.delete(id); rej(e); });
    });
  }
  notify(method: string, params: any = {}) { return this.send({ jsonrpc: "2.0", method, params }).catch(() => {}); }
  async init(): Promise<Tool[]> {
    if (this.transport === "stdio") this.startStdio(); else if (this.transport === "sse") await this.startSse();
    const info = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "atom", version: "0.3.0" } });
    await this.notify("notifications/initialized");
    const tools: any[] = []; let cursor: string | undefined;
    do { const r = await this.request("tools/list", cursor ? { cursor } : {}); tools.push(...(r.tools || [])); cursor = r.nextCursor; } while (cursor);
    const out: Tool[] = tools.map((t: any): Tool => ({
      name: `mcp__${this.name}__${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
      description: `[MCP ${this.name}] ${t.description || t.name}`,
      parameters: t.inputSchema || { type: "object", properties: {} },
      readOnly: !!t.annotations?.readOnlyHint,
      preview: (a) => `MCP ${this.name}.${t.name}(${JSON.stringify(a).slice(0, 200)})`,
      run: async (a) => {
        const r = await this.request("tools/call", { name: t.name, arguments: a }, 120000);
        const txt = (r.content || []).map((c: any) => (c.type === "text" ? c.text : c.type === "resource" ? c.resource?.text || `[resource ${c.resource?.uri}]` : `[${c.type}]`)).join("\n") || (r.structuredContent ? JSON.stringify(r.structuredContent) : JSON.stringify(r));
        return r.isError ? `Error: ${txt}` : txt;
      },
    }));
    if (info?.capabilities?.resources) out.push({
      name: `mcp__${this.name}__read_resource`.slice(0, 64), readOnly: true,
      description: `[MCP ${this.name}] List resources (no uri) or read one resource by uri.`,
      parameters: { type: "object", properties: { uri: { type: "string" } } },
      run: async (a) => a.uri ? ((await this.request("resources/read", { uri: a.uri })).contents || []).map((c: any) => c.text ?? `[blob ${c.mimeType}]`).join("\n") : ((await this.request("resources/list")).resources || []).map((r: any) => `${r.uri}  ${r.name || ""}`).join("\n"),
    });
    return out;
  }
  close() { try { this.proc?.kill(); } catch {} try { this.sseAbort?.abort(); } catch {} if (this.transport === "http" && this.sessionId) fetch(this.cfg.url!, { method: "DELETE", headers: { "mcp-session-id": this.sessionId, ...(this.cfg.headers || {}) } }).catch(() => {}); }
}
