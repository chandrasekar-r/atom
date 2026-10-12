import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, ensureDir } from "./config.js";

/** Self-update for Atom installs from the private GitHub repo.
 *  Git checkout: fetch tags → fast-forward/checkout the newest vX.Y.Z tag → npm install + build.
 *  npm global install: `npm i -g` from the registry (or the release's packed .tgz).
 *  Other installs: download the source tarball (public repo; a token from GH_TOKEN/`gh auth token` is used if present) → build → replace files. */
export const REPO = process.env.ATOM_UPDATE_REPO || "chandrasekar-r/atom";
const CACHE = () => path.join(CONFIG_DIR, "update-check.json");
const DAY = 24 * 3600 * 1000;
export const installDir = () => process.env.ATOM_INSTALL_DIR ? path.resolve(process.env.ATOM_INSTALL_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const installedVersion = (dir = installDir()) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version as string; } catch { return "0.0.0"; } };
export function cmpVer(a: string, b: string): number { const pa = a.replace(/^v/, "").split(/[.-]/).map((x) => +x || 0), pb = b.replace(/^v/, "").split(/[.-]/).map((x) => +x || 0); for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); return 0; }
const isGit = (dir: string) => fs.existsSync(path.join(dir, ".git"));
const sh = (cmd: string, args: string[], cwd: string, quiet = true) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit", timeout: 600000 }) || "";
export function githubToken(): string | null {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)!;
  try { return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim() || null; } catch { return null; }
}
async function gh(pathname: string, token: string | null): Promise<any> {
  const r = await fetch(`https://api.github.com${pathname}`, { headers: { accept: "application/vnd.github+json", "user-agent": "atom-cli", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  if (!r.ok) throw new Error(`GitHub ${pathname}: ${r.status}`); return r.json();
}
export interface Latest { version: string; tag: string; notes: string; source: "release" | "tag" | "git" | "npm"; url?: string; asset?: string }
export const NPM_NAME = "@chandrasekar-r/atom";
async function npmLatest(): Promise<string | null> { try { const r = await fetch(`https://registry.npmjs.org/${NPM_NAME.replace("/", "%2F")}/latest`); if (!r.ok) return null; return (await r.json() as any).version || null; } catch { return null; } }
const isNpmGlobal = (dir: string) => dir.split(path.sep).includes("node_modules");

/** Find the newest release: GitHub releases API (token) → tags API → `git ls-remote --tags` in a git install. */
export async function latestRelease(dir = installDir()): Promise<Latest> {
  const token = githubToken(); const errs: string[] = [];
  try { const r = await gh(`/repos/${REPO}/releases/latest`, token); return { version: r.tag_name.replace(/^v/, ""), tag: r.tag_name, notes: r.body || "", source: "release", url: r.html_url, asset: (r.assets || []).find((a: any) => a.name.endsWith(".tgz"))?.browser_download_url }; } catch (e: any) { errs.push(e.message); }
  const nv = await npmLatest(); if (nv) return { version: nv, tag: "v" + nv, notes: "", source: "npm" };
  try { const t: any[] = await gh(`/repos/${REPO}/tags?per_page=100`, token); const best = t.map((x) => x.name).filter((n) => /^v?\d+\.\d+\.\d+$/.test(n)).sort(cmpVer).pop(); if (best) return { version: best.replace(/^v/, ""), tag: best, notes: "", source: "tag" }; } catch (e: any) { errs.push(e.message); }
  if (isGit(dir)) { const out = sh("git", ["ls-remote", "--tags", "origin"], dir); const best = [...out.matchAll(/refs\/tags\/(v?\d+\.\d+\.\d+)$/gm)].map((m) => m[1]).sort(cmpVer).pop(); if (best) return { version: best.replace(/^v/, ""), tag: best, notes: "", source: "git" }; }
  throw new Error("could not determine the latest version (" + errs.join("; ") + "). Log in with `gh auth login` or set GH_TOKEN.");
}

/** Changelog sections strictly newer than `from` and up to `to` from CHANGELOG.md ("## vX.Y.Z" headings). */
export function changelogBetween(text: string, from: string, to: string): string {
  const parts = text.split(/^(?=## v?\d+\.\d+\.\d+)/m).filter((p) => /^## /.test(p));
  return parts.filter((p) => { const v = p.match(/^## v?(\d+\.\d+\.\d+)/)![1]; return cmpVer(v, from) > 0 && cmpVer(v, to) <= 0; }).join("\n").trim();
}

export async function checkForUpdate(force = false): Promise<{ current: string; latest?: Latest; available: boolean; cached: boolean }> {
  const current = installedVersion();
  let c: any = {}; try { c = JSON.parse(fs.readFileSync(CACHE(), "utf8")); } catch {}
  if (!force && c.checked && Date.now() - c.checked < DAY && c.latest) return { current, latest: c.latest, available: cmpVer(c.latest.version, current) > 0, cached: true };
  const latest = await latestRelease(); ensureDir(CONFIG_DIR); fs.writeFileSync(CACHE(), JSON.stringify({ checked: Date.now(), latest }));
  return { current, latest, available: cmpVer(latest.version, current) > 0, cached: false };
}

/** Perform the update in `dir`. Returns old/new versions and the changelog. */
export async function performUpdate(log: (s: string) => void, dir = installDir(), target?: Latest): Promise<{ from: string; to: string; changelog: string }> {
  const from = installedVersion(dir); const latest = target || await latestRelease(dir);
  if (cmpVer(latest.version, from) <= 0) return { from, to: from, changelog: "" };
  log(`updating ${dir} from v${from} to v${latest.version} (${isGit(dir) ? "git" : isNpmGlobal(dir) ? "npm" : "release tarball"})`);
  if (isGit(dir)) {
    // npm rewrites package-lock.json on install; that alone shouldn't block an update
    const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"], dir).split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    if (dirty.length && dirty.every((f) => f === "package-lock.json")) { sh("git", ["checkout", "--", "package-lock.json"], dir); dirty.length = 0; }
    if (dirty.length) throw new Error(`${dir} has uncommitted changes; commit or stash them first`);
    sh("git", ["fetch", "--tags", "--force", "origin"], dir);
    const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], dir).trim();
    let ff = false; if (branch !== "HEAD") { try { sh("git", ["merge", "--ff-only", latest.tag], dir); ff = true; } catch {} }
    if (!ff) sh("git", ["-c", "advice.detachedHead=false", "checkout", latest.tag], dir);
    log("installing dependencies + building…"); sh("npm", ["install", "--no-audit", "--no-fund"], dir); sh("npm", ["run", "build"], dir);
  } else if (isNpmGlobal(dir)) {
    // installed with `npm i -g`: prefer the npm registry, else the release's packed tarball
    const nv = await npmLatest(); const spec = nv && cmpVer(nv, latest.version) >= 0 ? `${NPM_NAME}@${nv}` : latest.asset;
    if (!spec) throw new Error("no npm version or release tarball found for " + latest.tag);
    log(`npm install -g ${spec}`); sh("npm", ["install", "-g", "--no-audit", "--no-fund", spec], os.tmpdir(), false);
  } else {
    const token = githubToken();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atom-up-")); const tgz = path.join(tmp, "src.tgz");
    const r = await fetch(`https://api.github.com/repos/${REPO}/tarball/${latest.tag}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "user-agent": "atom-cli" } });
    if (!r.ok) throw new Error(`download ${latest.tag}: ${r.status}`); fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    const src = path.join(tmp, "src"); fs.mkdirSync(src); sh("tar", ["xzf", tgz, "-C", src, "--strip-components=1"], tmp);
    log("installing dependencies + building…"); sh("npm", ["install", "--no-audit", "--no-fund"], src); sh("npm", ["run", "build"], src);
    // replace: keep a backup of the old install for rollback
    const bak = dir + `.bak-${from}`; fs.rmSync(bak, { recursive: true, force: true });
    fs.cpSync(dir, bak, { recursive: true });
    for (const e of fs.readdirSync(dir)) if (!e.startsWith(".")) fs.rmSync(path.join(dir, e), { recursive: true, force: true });
    fs.cpSync(src, dir, { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true }); log(`previous version backed up to ${bak}`);
  }
  const to = installedVersion(dir);
  let changelog = latest.notes; try { const cl = changelogBetween(fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"), from, to); if (cl) changelog = cl; } catch {}
  try { fs.writeFileSync(CACHE(), JSON.stringify({ checked: Date.now(), latest: { ...latest, version: to } })); } catch {}
  return { from, to, changelog };
}

/** Startup hook: read the cached check (never blocks); refresh it in a detached child once a day; auto-install if enabled. */
export function startupUpdateCheck(autoUpdate: boolean): string {
  if (process.env.ATOM_DISABLE_AUTOUPDATE || process.env.CI) return "";
  const current = installedVersion(); let c: any = {}; try { c = JSON.parse(fs.readFileSync(CACHE(), "utf8")); } catch {}
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "atom.js"); // this running copy of atom
  const bg = (args: string[]) => { try { ensureDir(CONFIG_DIR); const out = fs.openSync(path.join(CONFIG_DIR, "update.log"), "a"); spawn(process.execPath, [bin, ...args], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, ATOM_DISABLE_AUTOUPDATE: "1" } }).unref(); } catch {} };
  if (!c.checked || Date.now() - c.checked > DAY) bg(["update", "--check", "--quiet"]);
  if (c.latest && cmpVer(c.latest.version, current) > 0) {
    if (autoUpdate && !c.installing) { try { fs.writeFileSync(CACHE(), JSON.stringify({ ...c, installing: Date.now() })); } catch {} bg(["update", "--yes"]); return `updating to v${c.latest.version} in background`; }
    return `update v${c.latest.version} available · atom update`;
  }
  return "";
}
