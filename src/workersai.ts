import { Credentials } from "./config.js";

/** Raw Workers AI model run (embeddings, classifiers…), via the REST API or the Atom gateway's /v1/run. */
export const EMBED_MODEL = "@cf/baai/bge-m3";
export const CLASSIFIER_MODEL = "@cf/cloudflare/clef-flash";

export async function runModel(c: Credentials, model: string, input: any, signal?: AbortSignal): Promise<any> {
  const url = c.kind === "gateway" ? `${c.url.replace(/\/$/, "")}/v1/run/${model}` : `https://api.cloudflare.com/client/v4/accounts/${c.accountId}/ai/run/${model}`;
  const tok = c.kind === "gateway" ? c.key : c.kind === "api_token" ? c.apiToken : c.accessToken;
  let res: Response | undefined;
  for (let i = 0; i < 3; i++) {
    res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(input), signal });
    if (res.ok || (res.status < 500 && res.status !== 429)) break;
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  const j: any = await res!.json().catch(() => ({}));
  if (!res!.ok || j.success === false) throw new Error(`Workers AI ${model} ${res!.status}: ${JSON.stringify(j.errors || j.error || j).slice(0, 300)}`);
  return j.result;
}

/** Embed texts with a bge model (batched). */
export async function embed(c: Credentials, texts: string[], model = EMBED_MODEL): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const r = await runModel(c, model, { text: texts.slice(i, i + 32).map((t) => t.slice(0, 6000) || " ") });
    out.push(...r.data);
  }
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

export type ClefQuestion = { type: "noul"; instructions: string } | { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "score"; instructions: string; criteria: string[] };
/** Cloudflare Clef-flash decision model: state + typed questions -> probabilities. */
export async function classify(c: Credentials, state: string, questions: Record<string, ClefQuestion>, model = CLASSIFIER_MODEL): Promise<Record<string, any>> {
  const r = await runModel(c, model, { model: model.split("/").pop(), state, questions });
  return r.answers || {};
}
