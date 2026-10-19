# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

githippo is an MCP memory server (Node ≥20, ESM, plain JavaScript, no build step). Memory is Markdown in a git repo; recall is hybrid BM25 + embeddings + knowledge-graph hop. It also ships Claude Code hooks, a CLI, a remote Streamable-HTTP server with OAuth, and a Claude Desktop `.mcpb` bundle.

## Commands

```bash
npm ci --ignore-scripts           # install (CI uses --ignore-scripts)
npm test                          # all tests, offline, against a fake GitHub API; no tokens needed
node --test test/core.test.js     # one file
node --test --test-name-pattern="supersede" test/*.test.js   # tests matching a name
npm run fuzz                      # seeded fuzzer; FUZZ_SEED=<n> FUZZ_ITERATIONS=<k> to reproduce/go deeper
npm run bench                     # token cost of the tool surface (CI runs it)
node scripts/versions.mjs         # check every version string / pinned tag agrees
node scripts/versions.mjs X.Y.Z   # bump all of them at once
node src/cli.js <command> --help  # run the CLI from source (serve, http, hook <event>, doctor, demo, eval, …)
```

There is no linter or formatter config. CI (`.github/workflows/ci.yml`) runs `npm test`, `bench` and a light fuzz pass on Node 20, 22 and 24.

## Architecture

Request path: `server.js` (MCP tool surface) → `Brain` (`brain.js`, all memory semantics) → a **store** + a `MemoryIndex` (`search.js`).

- **Stores share one interface** (`read/list/write/append/replace/delete/history/at/activeDays`), with git blob SHAs as version tokens for optimistic concurrency. A write against a stale SHA fails, and the caller gets the current file back to merge.
  - `filestore.js`: local vault (`~/.githippo/vault`, a git repo). The default (`STORE=local`). Pushes in the background if a remote exists, and refuses to write during an unfinished merge or rebase or with conflict markers present.
  - `store.js`: `GitHubMemoryStore` via the GitHub Contents API (`STORE=github`, used by the remote server). It also defines `MemoryError` and `normalizePath`.
  - `memstore.js`: in-memory, for `demo`.
- `createBrain()` in `server.js` wires config, store, embedder, index and LLM. `loadConfig` (`config.js`) resolves env var, then `~/.githippo/config.json`, then the default. Hooks don't get the MCP env, so they rely on that config file.
- `search.js`: BM25 + dense vectors fused with RRF, then expanded one hop via `graph.js` (`[[wikilinks]]`, typed relations `rel:: [[x]]`). Vectors are cached in a binary format (`vecstore.js`). `embed.js` selects the provider (`local` runs in a child process via `embed-worker.js`; `static`, `voyage`, `none`). Per-model score thresholds are calibrated in `docs/calibration.md`. Tests use `hashEmbedder()`.
- Write-path safety lives in `Brain` and runs on every write route, including the memory tool, the importer and consolidation: `guard.js` (secrets/ID scan and redaction), `injection.js` (refuses instruction-like text), `[external]` source marking (`parse.js`), and `confirm.js` (MCP elicitation for external facts, pins and forgets). Core memory (`core.md`) is written **only** by `remember pin=true`. Keep that single door when adding features.
- `parse.js` handles the Markdown format (frontmatter + bullet facts under headings, `~~struck~~` history lines for supersession). Treat frontmatter as untrusted input.
- `hooks.js` + `transcript.js` implement the Claude Code hooks (`hooks/hooks.json`: PreCompact, PostCompact, SessionStart, SessionEnd, UserPromptSubmit). The checkpoint is built deterministically from the transcript, without an LLM.
- `http.js` (stateless: a fresh MCP server per request, with a shared brain), `oauth.js` (OAuth 2.1, HMAC-signed stateless tokens) and `accounts.js` (multi-user, path-prefix ACLs, `AclStore` wrapping a store) make up the remote mode.
- Optional LLM features (`consolidate.js`, `contextualize.js`, via `llm.js`) only run with `ANTHROPIC_API_KEY`. Their output is treated as untrusted.
- `memorytool.js` backs Anthropic's native `memory_20250818` tool with the vault.
- `eval/` holds the retrieval benchmark (`githippo eval`). CI enforces a quality floor on keyword retrieval.

## Conventions and ground rules

- **Tokens are a feature.** Tool descriptions, schemas, server `instructions()` and response formats (`format.js` renders compact text, not JSON) ship on every turn. Measure with `npm run bench` before growing them.
- **Hooks must never break a session.** Every failure path exits 0, with short timeouts.
- No telemetry. Nothing leaves the user's repo or server.
- Tests come first for routing, dedupe and retrieval changes. Use `setup()` in `test/helpers.js` for a seeded vault on the fake GitHub. Timing assertions scale by `speedFactor()`. Bug-report regressions go in `test/reportN*.test.js`, and comments cite IDs like `B7`.
- Version bumps go through `scripts/versions.mjs`. Versions live in `package.json`, the lockfile, `manifest.json`, `.claude-plugin/*`, `VERSION` in `src/server.js`, `install.sh` and the pinned `githippo#vX.Y.Z` tags in the README and other docs. Pushing a `v*` tag triggers `release.yml` (tests, `.mcpb` build, GitHub release, MCP Registry publish).
