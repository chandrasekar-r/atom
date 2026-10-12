// Retrieval eval: semantic-only vs hybrid (graph expansion + rerank / fusion) on a real multi-language repo.
// usage: node test/eval-hybrid.mjs /path/to/microservices-demo
import { loadCredentials } from "../dist/config.js";
import { RepoIndex } from "../dist/repoindex.js";
import { CodeGraph } from "../dist/codegraph.js";
import { hybridSearch } from "../dist/hybrid.js";
const root = process.argv[2]; const c = loadCredentials(); const idx = new RepoIndex(c, root); const g = new CodeGraph(root);
const S = "src/";
// [question, [[file, line]...]]  line 0 = any span in the file counts
const Q = [
  ["How is the order total calculated during checkout, including shipping cost?", [[S + "checkoutservice/main.go", 246]]],
  ["Where is the credit card validated and charged?", [[S + "paymentservice/charge.js", 0]]],
  ["How does the currency service convert money between currencies?", [[S + "currencyservice/server.js", 140]]],
  ["Where are shipment tracking IDs generated?", [[S + "shippingservice/tracker.go", 25]]],
  ["How is the shipping cost quote computed from the number of items?", [[S + "shippingservice/quote.go", 36]]],
  ["What happens on the server when the user submits the place order form?", [[S + "frontend/handlers.go", 325]]],
  ["How are product recommendations chosen for a user?", [[S + "recommendationservice/recommendation_server.py", 72]]],
  ["How does product search in the catalog work?", [[S + "productcatalogservice/product_catalog.go", 62]]],
  ["Where is the product catalog loaded from AlloyDB?", [[S + "productcatalogservice/catalog_loader.go", 86]]],
  ["How does the ad service pick ads for the requested context keys?", [[S + "adservice/src/main/java/hipstershop/AdService.java", 100]]],
  ["Where is the order confirmation email sent from the email service?", [[S + "emailservice/email_server.py", 0]]],
  ["Which function calls chargeCard?", [[S + "checkoutservice/main.go", 252]]],
  ["Where does the frontend call the currency service to convert a price?", [[S + "frontend/rpc.go", 78]]],
  ["What code depends on money.Sum in the checkout service?", [[S + "checkoutservice/main.go", 246]]],
  ["Where is the user's cart emptied after an order is placed?", [[S + "checkoutservice/main.go", 263], [S + "checkoutservice/main.go", 333]]],
  ["How is the selected currency remembered when the user switches currency?", [[S + "frontend/handlers.go", 505]]],
  ["What calls getRandomAds in the ad service?", [[S + "adservice/src/main/java/hipstershop/AdService.java", 105]]],
  ["Which code calls CreateTrackingId?", [[S + "shippingservice/main.go", 0]]],
];
const hit = (h, gold) => gold.some(([f, l]) => h.file === f && (l === 0 || (h.start <= l && h.end >= l)));
async function run(name, fn) {
  let h1 = 0, h5 = 0, mrr = 0; const rows = [];
  for (const [q, gold] of Q) { const r = await fn(q); const i = r.findIndex((h) => hit(h, gold)); if (i === 0) h1++; if (i >= 0 && i < 5) { h5++; mrr += 1 / (i + 1); } rows.push(i >= 0 && i < 5 ? i + 1 : "-"); }
  const n = Q.length; console.log(`${name.padEnd(22)} hit@1 ${(h1 / n * 100).toFixed(0).padStart(3)}%  hit@5 ${(h5 / n * 100).toFixed(0).padStart(3)}%  MRR@5 ${(mrr / n).toFixed(3)}  ranks ${rows.join(" ")}`);
  return { h1, h5, mrr: mrr / n };
}
await g.update();
console.log(`${Q.length} questions · ${g.stats().symbols} symbols · ${idx.stats().chunks} chunks`);
await run("semantic only", (q) => idx.search(q, 5));
await run("hybrid (fusion)", (q) => hybridSearch(c, idx, g, q, 5, { rerank: false }));
await run("hybrid (+reranker)", (q) => hybridSearch(c, idx, g, q, 5));
