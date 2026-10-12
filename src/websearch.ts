import { Tool } from "./tools.js";

const ent = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const real = (u: string) => { const m = u.match(/[?&]uddg=([^&]+)/); return m ? decodeURIComponent(m[1]) : u.startsWith("//") ? "https:" + u : u; };
export interface SearchHit { title: string; url: string; snippet: string }
async function ddg(q: string, n: number): Promise<SearchHit[]> {
  const html = await (await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { "user-agent": "Mozilla/5.0" } })).text(); const hits: SearchHit[] = [];
  for (const blk of html.split(/class="result results_links/).slice(1)) {
    const a = blk.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/); if (!a) continue;
    const sn = blk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const url = real(a[1].replace(/&amp;/g, "&")); if (/duckduckgo\.com\/y\.js/.test(url)) continue;
    hits.push({ title: ent(a[2]), url, snippet: sn ? ent(sn[1]) : "" }); if (hits.length >= n) break;
  }
  return hits;
}
async function bingRss(q: string, n: number): Promise<SearchHit[]> {
  const x = await (await fetch(`https://www.bing.com/search?format=rss&q=${encodeURIComponent(q)}`, { headers: { "user-agent": "Mozilla/5.0" } })).text();
  return [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, n).map((m) => ({ title: ent((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""), url: ent((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ""), snippet: ent((m[1].match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "") }));
}
/** Free, keyless web search: DuckDuckGo HTML, falling back to Bing's public RSS results when DDG rate-limits. */
export async function webSearch(q: string, n = 8): Promise<SearchHit[]> {
  for (const eng of [ddg, bingRss]) { try { const h = await eng(q, n); if (h.length) return h; } catch {} }
  return [];
}
export const webSearchTool: Tool = {
  name: "web_search", readOnly: true,
  description: "Search the web (DuckDuckGo/Bing, no key needed) for current information: docs, library versions, error messages, news. Returns titles, URLs and snippets; follow up with web_fetch on the best URL.",
  parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number" } }, required: ["query"] },
  async run(a) {
    const hits = await webSearch(a.query, Math.min(15, a.max_results || 8));
    return hits.length ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n") : "No results.";
  },
};
