/** Minimal unified-style line diff (LCS). Good enough for showing edits. */
export function lineDiff(a: string, b: string, ctx = 2): string {
  const A = a.split("\n"), B = b.split("\n");
  if (A.length * B.length > 4_000_000) return `(large change: ${A.length} -> ${B.length} lines)`;
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: [string, string][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { ops.push([" ", A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", A[i++]]); else ops.push(["+", B[j++]]); }
  while (i < n) ops.push(["-", A[i++]]); while (j < m) ops.push(["+", B[j++]]);
  const keep = ops.map((o, k) => o[0] !== " " || ops.slice(Math.max(0, k - ctx), k + ctx + 1).some((x) => x[0] !== " "));
  const out: string[] = []; let skipped = false;
  ops.forEach((o, k) => { if (keep[k]) { out.push(o[0] + " " + o[1]); skipped = false; } else if (!skipped) { out.push("  ..."); skipped = true; } });
  return out.join("\n");
}
export function colorDiff(d: string): string {
  return d.split("\n").map((l) => (l.startsWith("+") ? `\x1b[32m${l}\x1b[0m` : l.startsWith("-") ? `\x1b[31m${l}\x1b[0m` : `\x1b[2m${l}\x1b[0m`)).join("\n");
}
