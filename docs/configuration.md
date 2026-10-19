# Configuration

| Variable | Default | |
|---|---|---|
| `VAULT_DIR` | `~/.githippo/vault` | local memory vault (a git repo) |
| `STORE` | `local` | `github` reads/writes via the GitHub API instead (used by the remote server) |
| `GITHUB_TOKEN`, `MEMORY_REPO` | | only for `STORE=github` / remote mode |
| `MCP_SECRET` | | remote mode, 24+ chars: owner login and OAuth signing key |
| `PUBLIC_URL` | | remote mode: the server's public https URL (OAuth issuer) |
| `TRUST_PROXY` | | remote mode: set to `1` behind a reverse proxy (Render, nginx…). Rate limits then use the right-most `X-Forwarded-For` entry, the address your proxy appended. Without it, `X-Forwarded-For`, `-Host` and `-Proto` are ignored, because any client can forge them |
| `OAUTH_STATE_FILE` | `~/.githippo/oauth-state.json` | remote mode: remembers spent login codes, spent refresh tokens and revoked sign-ins across restarts, and servers sharing the file pick up each other's entries (on a host with no persistent disk, a restart forgets them; the Render blueprint attaches one) |
| `USERS_JSON` | | remote multi-user: contents of `githippo users` file |
| `EMBEDDINGS` | `local` | `local` (paraphrase-multilingual-MiniLM-L12-v2 in a separate process: ~520 MB while in use, exits after `EMBED_IDLE_MS`, default 10 min); `static` (Model2Vec lookup-table embeddings, `STATIC_EMBED_MODEL=minishlab/potion-base-8M` is ~100× faster at ~200 MB with about the same LongMemEval score, but English-only); `voyage`, or `none` (keyword only). Choice and thresholds are measured in [docs/calibration.md](calibration.md) |
| `LOCAL_EMBED_MODEL` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | Which model `EMBEDDINGS=local` runs. `onnx-community/embeddinggemma-300m-ONNX` (Google EmbeddingGemma-300M, q4, a ~209 MB download on first use) finds paraphrased and cross-language questions better (on [eval/paraphrase.js](benchmarks.md): 61% against 52% hit@1) and uses less memory, but indexes about 5× slower (23 against 116 chunks a second) and is under the Gemma terms of use, not an open-source licence. Changing it re-embeds the vault in the background (keyword search works meanwhile). Run `githippo warm` afterwards to fetch it. `GITHIPPO_EMBED_DIMS=256` keeps the first 256 of its 768 dimensions (Matryoshka): a third of the storage for about 1.7 points of hit@5. |
| `MEMORY_ROOT` / `MEMORY_BRANCH` | `memory` / `main` | |
| `CORE_BUDGET_TOKENS` | `400` | hard cap for pinned memory |
| `MEMORY_STYLE` | `plain` | `terse` removes padding (articles, filler) from recalled memory and core before Claude reads it; files on disk are never changed. Rules from [caveman](https://github.com/JuliusBrussee/caveman), limited to deletions that can't change meaning: negations, numbers, names, code, URLs and paths always survive. Measured saving is small (about 3% on terse notes, 10% on wordy ones), and caveman's own cited research found compressing what a model reads can hurt answers, so it's off by default |
| `GITHIPPO_CONFIRM` | `auto` | `auto` asks for confirmation on external-source facts, pins and removals when the client supports MCP elicitation; `strict` refuses them without it; `off` never asks |
| `PROMPT_RECALL` | `1` | `0` turns off the per-prompt hook |
| `ANTHROPIC_API_KEY` | | paid model calls: `maintain rewrite=`, `consolidate`, `contextualize` and the `llm-eval` benchmarks (nothing else uses it) |
| `VOYAGE_API_KEY` | | for `EMBEDDINGS=voyage` |
| `GITHIPPO_ALLOW_PUBLIC_BACKUP` | | set to `1` to let githippo push to a backup repository that is publicly readable (it refuses by default) |
