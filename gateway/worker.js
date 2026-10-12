// Atom gateway: a tiny Worker that exposes your account's Workers AI binding
// as an OpenAI-compatible endpoint (plus raw model runs and optional D1 memory sync),
// protected by a shared key.
const te = new TextEncoder();
async function safeEqual(a, b) { // constant-time comparison via HMAC digests
  const k = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const [x, y] = await Promise.all([crypto.subtle.sign("HMAC", k, te.encode(a)), crypto.subtle.sign("HMAC", k, te.encode(b))]);
  return crypto.subtle.timingSafeEqual ? crypto.subtle.timingSafeEqual(x, y) : new Uint8Array(x).every((v, i) => v === new Uint8Array(y)[i]);
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return Response.json({ ok: true, memory: !!env.DB, key_ok: (env.ATOM_KEY || "").length >= 32 });
    const auth = req.headers.get("authorization") || "";
    if (!env.ATOM_KEY || !(await safeEqual(auth, `Bearer ${env.ATOM_KEY}`))) return new Response("unauthorized", { status: 401 });
    try {
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const { model, ...input } = await req.json();
        const out = await env.AI.run(model, input);
        if (out instanceof ReadableStream) return new Response(out, { headers: { "content-type": "text/event-stream" } });
        return Response.json(out);
      }
      // Raw model run, same shape as the REST API /ai/run/{model}: embeddings (bge), classifiers (clef-flash), etc.
      if (req.method === "POST" && url.pathname.startsWith("/v1/run/")) {
        const model = decodeURIComponent(url.pathname.slice(8));
        return Response.json({ success: true, result: await env.AI.run(model, await req.json()) });
      }
      if (url.pathname === "/v1/memory") {
        if (!env.DB) return Response.json({ error: "no D1 binding" }, { status: 501 });
        if (req.method === "GET") {
          const since = +(url.searchParams.get("since") || 0);
          const { results } = await env.DB.prepare("SELECT * FROM memories WHERE created >= ?").bind(since).all();
          return Response.json({ memories: results.map((r) => ({ ...r, vec: r.vec ? JSON.parse(r.vec) : null, deleted: !!r.deleted })) });
        }
        if (req.method === "POST") {
          const { memories = [] } = await req.json();
          const st = env.DB.prepare("INSERT INTO memories (id,scope,kind,text,vec,created,deleted) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, kind=excluded.kind, vec=excluded.vec, deleted=excluded.deleted");
          if (memories.length) await env.DB.batch(memories.map((m) => st.bind(m.id, m.scope || "global", m.kind || "fact", m.text, m.vec ? JSON.stringify(m.vec) : null, m.created || Date.now(), m.deleted ? 1 : 0)));
          return Response.json({ ok: true, upserted: memories.length });
        }
      }
    } catch (e) { return Response.json({ error: String(e?.message || e) }, { status: 502 }); }
    return new Response("not found", { status: 404 });
  },
};
