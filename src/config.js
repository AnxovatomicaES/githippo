// Config: environment variables win, then ~/.githippo/config.json (written by
// `githippo install`, needed because Claude Code hooks don't get the MCP env).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// B11: "~/…" in env or config means the home directory, not a folder literally named "~".
export const expandHome = (p) => (typeof p === "string" && /^~(?=$|\/)/.test(p) ? join(homedir(), p.slice(1)) : p);
export const HOME_DIR = expandHome(process.env.GITHIPPO_HOME) || join(homedir(), ".githippo");
export const CONFIG_FILE = join(HOME_DIR, "config.json");

const KEYS = [
  "GITHUB_TOKEN", "MEMORY_REPO", "MEMORY_BRANCH", "MEMORY_ROOT", "EMBEDDINGS", "LOCAL_EMBED_MODEL",
  "VOYAGE_API_KEY", "VOYAGE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "MCP_SECRET", "CACHE_DIR",
  "CORE_BUDGET_TOKENS", "PROMPT_RECALL", "GITHIPPO_HOOK_PROFILE", "GITHIPPO_DISABLED_HOOKS", "DECAY_ACTIVE_DAYS",
  "STORE", "VAULT_DIR", "MEMORY_STYLE",
  "STATIC_EMBED_MODEL", "GITHIPPO_CONFIRM", "RERANK", "RERANK_MODEL", "EMBED_IDLE_MS", "GIT_SIGN", "CONSOLIDATE",
  "TRUST_PROXY", "LEGACY_SECRET_URL", "PUBLIC_URL", "OAUTH_STATE_FILE", "PORT",
];

/**
 * One precedence rule everywhere: environment variable > ~/.githippo/config.json > built-in default.
 * Modules that read process.env directly (confirmations, reranking, proxy trust…) see config.json values because
 * the CLI copies any key the environment doesn't set into process.env once, at startup.
 */
export function applyFileConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return;
  }
  for (const k of KEYS) if (env[k] === undefined && file[k] !== undefined && file[k] !== null && file[k] !== "") env[k] = String(file[k]);
}

export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const cfg = {};
  for (const k of KEYS) if (env[k] ?? file[k]) cfg[k] = env[k] ?? file[k];
  cfg.CACHE_DIR = expandHome(cfg.CACHE_DIR) || join(HOME_DIR, "cache");
  cfg.VAULT_DIR = expandHome(cfg.VAULT_DIR) || join(HOME_DIR, "vault");
  // Local vault unless GitHub API mode is asked for (or implied by a repo + token, e.g. the remote server).
  cfg.STORE = cfg.STORE || (cfg.MEMORY_REPO && cfg.GITHUB_TOKEN ? "github" : "local");
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== "" && v != null ? Math.min(hi, Math.max(lo, +v)) : d);
  cfg.CORE_BUDGET_TOKENS = num(cfg.CORE_BUDGET_TOKENS, 400, 50, 4000);
  cfg.DECAY_ACTIVE_DAYS = num(cfg.DECAY_ACTIVE_DAYS, 20, 1, 3650);
  return cfg;
}

/**
 * Hook runtime switches (idea from Everything Claude Code), no file edits needed:
 *   GITHIPPO_HOOK_PROFILE=minimal  → only compaction save/restore
 *   GITHIPPO_HOOK_PROFILE=standard → everything (default)
 *   GITHIPPO_DISABLED_HOOKS=prompt,startup-note,steer,drift,postcompact
 */
export function hookEnabled(feature, cfg = loadConfig()) {
  const disabled = String(cfg.GITHIPPO_DISABLED_HOOKS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (feature === "prompt" && cfg.PROMPT_RECALL === "0") return false;
  if (disabled.includes(feature)) return false;
  if ((cfg.GITHIPPO_HOOK_PROFILE || "standard") === "minimal") return ["precompact", "restore"].includes(feature);
  return true;
}
