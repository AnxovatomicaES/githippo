// Is the backup remote publicly readable? Memory is personal, and a push to a public repository can't be taken back
// (forks, caches, search engines), so githippo checks before it pushes instead of trusting that the repo was made private.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const PUBLIC_TTL_MS = 5 * 60_000; // re-check soon: someone usually fixes it, and then pushing should resume
const PRIVATE_TTL_MS = 60 * 60_000; // hooks run one process per event; don't spend GitHub's 60 anonymous requests an hour on each

/** "owner/name" for a github.com remote URL (https, ssh:// or scp-like git@github.com:owner/name), otherwise null. */
export function githubRepoOf(url) {
  const m = String(url || "")
    .trim()
    .match(/^(?:https?:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** The remote URL with any embedded credentials removed (https://user:token@host → https://host). */
export const scrubUrl = (url) => String(url).replace(/(https?:\/\/)[^@\s/]+@/g, "$1");

/**
 * "public" when an anonymous request can read the repository, "private" when it can't (GitHub answers 404 for private
 * repositories and for ones that don't exist), "unknown" when we couldn't tell: offline, rate limited, or not a GitHub remote.
 * Results are cached per repository so a burst of hook processes makes one request.
 */
export async function remoteVisibility(url, { fetchImpl = globalThis.fetch, cacheFile = null, now = Date.now() } = {}) {
  const repo = githubRepoOf(url);
  if (!repo || !fetchImpl) return "unknown";
  const key = repo.toLowerCase();
  let cache = {};
  if (cacheFile) {
    try {
      cache = JSON.parse(readFileSync(cacheFile, "utf8")) || {};
    } catch {}
    const hit = cache[key];
    if (hit && (hit.v === "public" || hit.v === "private") && now - hit.t < (hit.v === "public" ? PUBLIC_TTL_MS : PRIVATE_TTL_MS)) return hit.v;
  }
  let v = "unknown";
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "githippo" }, // no Authorization header: that is the point
      signal: AbortSignal.timeout(4000),
    });
    v = res.status === 200 ? "public" : res.status === 404 ? "private" : "unknown";
  } catch {}
  if (cacheFile && v !== "unknown") {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...cache, [key]: { v, t: now } }));
      renameSync(tmp, cacheFile);
    } catch {}
  }
  return v;
}

export const publicBackupMessage = (url) =>
  `${scrubUrl(url)} is a PUBLIC repository: anyone can read your memory. Make it private (GitHub → Settings → Danger zone), or point the vault at a private repository.`;

/**
 * A FileStore `pushGuard`: resolves false (and says why, once) when the vault's origin is a public GitHub repository.
 * GITHIPPO_ALLOW_PUBLIC_BACKUP=1 turns the check off for people who really mean it. Unknown (offline, not GitHub) lets the push
 * go ahead, so a flaky network never stops a backup.
 */
export function makePushGuard({ cacheFile = null, env = process.env, fetchImpl = globalThis.fetch, log = console.error } = {}) {
  let warned = false;
  return async (store) => {
    if (env.GITHIPPO_ALLOW_PUBLIC_BACKUP === "1") return true;
    const url = (await store.git(["remote", "get-url", "origin"])).out;
    if ((await remoteVisibility(url, { fetchImpl, cacheFile })) !== "public") return true;
    if (!warned) {
      warned = true;
      log(`[githippo] NOT pushing: ${publicBackupMessage(url)} (GITHIPPO_ALLOW_PUBLIC_BACKUP=1 overrides.)`);
    }
    return false;
  };
}
