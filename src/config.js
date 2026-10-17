// Config: environment variables win, then ~/.githippo/config.json (written by
// `githippo install`, needed because Claude Code hooks don't get the MCP env).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME_DIR = process.env.GITHIPPO_HOME || join(homedir(), ".githippo");
export const CONFIG_FILE = join(HOME_DIR, "config.json");

const KEYS = [
  "GITHUB_TOKEN", "MEMORY_REPO", "MEMORY_BRANCH", "MEMORY_ROOT", "EMBEDDINGS", "LOCAL_EMBED_MODEL",
  "VOYAGE_API_KEY", "VOYAGE_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "MCP_SECRET", "CACHE_DIR",
  "CORE_BUDGET_TOKENS", "PROMPT_RECALL",
];

export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {}
  const cfg = {};
  for (const k of KEYS) if (env[k] ?? file[k]) cfg[k] = env[k] ?? file[k];
  cfg.CACHE_DIR ??= join(HOME_DIR, "cache");
  cfg.CORE_BUDGET_TOKENS = Number(cfg.CORE_BUDGET_TOKENS || 400);
  return cfg;
}
