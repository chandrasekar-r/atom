// Test MCP server over Streamable HTTP (/mcp, replies as SSE when the client accepts it) and legacy HTTP+SSE (/sse + /messages).
import http from "node:http";
const tools = [{ name: "weather_code", description: "Returns the secret weather code word for a city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] }, annotations: { readOnlyHint: true } }];
function handle(m) {
  if (m.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "http-demo", version: "1" } };
  if (m.method === "tools/list") return { tools };
  if (m.method === "tools/call") return { content: [{ type: "text", text: `code for ${m.params.arguments.city}: aurora-${String(m.params.arguments.city).length}` }] };
  if (m.method === "resources/list") return { resources: [{ uri: "demo://readme", name: "readme" }] };
  if (m.method === "resources/read") return { contents: [{ uri: m.params.uri, text: "resource body: marmalade" }] };
  return null;
}
const sseClients = new Map(); let n = 0;
const srv = http.createServer(async (req, res) => {
  const body = await new Promise((r) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => r(b)); });
  if (req.url === "/mcp" && req.method === "POST") {
    const m = JSON.parse(body); if (m.id == null) { res.writeHead(202).end(); return; }
    const out = { jsonrpc: "2.0", id: m.id, result: handle(m) };
    const h = { "mcp-session-id": "s-1" };
    if ((req.headers.accept || "").includes("text/event-stream") && m.method === "tools/call") { res.writeHead(200, { ...h, "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify(out)}\n\n`); }
    else { res.writeHead(200, { ...h, "content-type": "application/json" }); res.end(JSON.stringify(out)); }
    return;
  }
  if (req.url === "/sse" && req.method === "GET") {
    const id = String(++n); res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: endpoint\ndata: /messages?sid=${id}\n\n`); sseClients.set(id, res); return;
  }
  if (req.url.startsWith("/messages") && req.method === "POST") {
    const sid = new URL(req.url, "http://x").searchParams.get("sid"); const m = JSON.parse(body); res.writeHead(202).end();
    if (m.id != null) sseClients.get(sid)?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: handle(m) })}\n\n`); return;
  }
  res.writeHead(404).end();
});
srv.listen(+(process.argv[2] || 0), "127.0.0.1", () => console.log("PORT " + srv.address().port));
