<p align="center">
  <img src="assets/banner.svg" alt="githippo, a hippocampus for your AI" width="100%">
</p>

<p align="center">
  <a href="https://github.com/AnxovatomicaES/githippo/actions/workflows/ci.yml"><img src="https://github.com/AnxovatomicaES/githippo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/MCP-server-8b5cf6" alt="MCP server">
  <img src="https://img.shields.io/badge/license-MIT-a78bfa" alt="MIT">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-34d399" alt="Node 20+">
  <img src="https://img.shields.io/badge/backend-your%20own%20repo-f472b6" alt="Your own repo">
</p>

<h3 align="center">Claude forgets everything when the context compacts.<br>githippo doesn't.</h3>

<p align="center">
  <img src="assets/demo.svg" alt="githippo surviving a context compaction in Claude Code" width="100%">
</p>

Long-term memory for Claude and any MCP client, stored as plain Markdown in a git repo **you own**. Hybrid semantic search, a knowledge graph, auto-memory, compaction survival, and about 46% less per-turn overhead than a naive memory server. Every memory is a git commit you can read, diff and revert.

```bash
curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/install.sh | sh
```

That's the whole install: no account, no token, no questions. It sets up a local memory vault, wires Claude Code (hooks, MCP, status line) and fetches semantic search in the background. Restart Claude Code and just talk; it remembers.

Want it backed up and synced across machines? `githippo sync --github` creates a private repo with your existing GitHub CLI login and pushes after every change. Just curious? `npx -y github:AnxovatomicaES/githippo#v3.2.0 demo` shows it working in 30 seconds without installing anything.

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/AnxovatomicaES/githippo"><img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render"></a><br>
  <sub>one click → use it from claude.ai and your phone</sub>
</p>

---

## Why another memory server?

Because each good idea out there lives in a different tool. githippo takes the best of each and fixes the part that hurts:

| Idea | Borrowed from | githippo's twist |
|---|---|---|
| Entities + relations + observations | MCP reference memory server | Entities are Markdown files, relations are `[[wikilinks]]`, and search is **semantic, not substring**: "the language I prefer" finds "TypeScript" |
| Markdown you can edit, Obsidian graph | Basic Memory | Same human-readable files, but **synced through git**: every device, full history, zero cloud fees |
| Typed relations (`works_on [[x]]`) | Basic Memory, Dataview | Parsed into a queryable graph; recall follows links one hop automatically |
| Temporal facts ("what was true last quarter?") | Graphiti / Zep | Superseded facts move to a dated **History** section instead of vanishing, *and* `history at=<date>` gives exact time travel from git, with no graph DB and no LLM calls |
| Pinned "core memory" blocks | Letta (MemGPT) | Core memory rides **inside the MCP server instructions**, which live in the system prompt, so it survives compaction in *every* client, including claude.ai |
| Lifecycle hooks around compaction | claude-mem | The PreCompact hook builds the checkpoint **deterministically from the transcript** (goal, todo state, files changed, where it stopped). No LLM, no cost, can't hallucinate |
| Progressive disclosure | claude-mem | `recall mode=brief` returns one-line refs (~45 tokens) before you pay for full context |
| Consolidation / dedupe | mcp-memory-service, Mem0 | Embedding-based duplicate detection on every write, plus `maintain` health reports; optional LLM merge that **refuses lossy rewrites** (dropped links or frontmatter) |
| Remote MCP for claude.ai | Supermemory, Mem0 | Self-hosted Streamable HTTP; your data never leaves your repo and your server |

Version 3.1 adds the best idea from each of nine other memory tools, read in their source and credited in [docs/prior-art.md](docs/prior-art.md): `<private>` tags, compaction steering and summary capture, session diffing, activity-aware decay, a code-aware tokenizer, errors in checkpoints, an honest status line, plugin packaging and `alwaysLoad` registration.

And things we haven't seen elsewhere, as far as we know:

- **Compliance guard.** Blocks API keys, tokens, private keys, IBANs (mod-97 checked), card numbers (Luhn checked), Spanish DNI/NIE (checksum) and US SSNs *before* they become permanent git history.
- **Compaction-proof by design**, three ways (see below).
- **Cross-lingual recall.** The default multilingual embedder runs locally; ask in Spanish, find notes written in English.
- **Updates are never mistaken for duplicates.** "Launch is end of Q1" and "end of Q2" embed almost identically. githippo also compares numbers, dates and names, so the update is saved, the old line is flagged, and `maintain` reports possible contradictions. Measured in [docs/calibration.md](docs/calibration.md).
- **Optimistic concurrency.** Two sessions editing the same memory can't clobber each other; the loser gets the current file back and merges.

## Survives compaction, three layers deep

When Claude Code compacts a long session, the conversation gets summarised and details die. githippo makes sure what matters doesn't.

```mermaid
flowchart LR
  A[Context fills up] --> B[PreCompact hook]
  B -->|parse transcript, no LLM| C[checkpoint: goal, todos, files, where it stopped]
  C --> D[(local ~/.githippo)]
  C --> E[(repo sessions/)]
  F[Compaction] --> G[SessionStart hook, source=compact]
  D --> G
  G -->|injects the state itself, not a reminder to read it| H[Claude continues exactly where it stopped]
  I[MCP instructions + core memory] -.->|system prompt, never compacted| H
```

1. **Core memory in the system prompt.** MCP server instructions aren't part of the conversation, so compaction can't touch them. Your pinned facts are always there, in any MCP client.
2. **Hook-driven checkpoint** (Claude Code). A common complaint is that a post-compaction hook which only *reminds* Claude to re-read a state file is hit or miss. githippo injects the content directly.
3. **`checkpoint` tool** (any client, including claude.ai). Claude saves task, state and next step at milestones. After context loss, `checkpoint` with no args restores it.

Bonus: a fresh session in the same project and branch within 24h gets a brief "last time you were…" note, including what changed in git since (commits, commits by others, branch switches, deleted files). The **UserPromptSubmit** hook proactively surfaces up to three relevant memories when the match is confident. It's capped at 300 tokens, skips trivial prompts and never repeats within a session. Before compaction, githippo also tells the compactor what must survive, and after compaction it keeps the compactor's summary with the checkpoint.

How we know the hooks do what we say: the contracts were read from Claude Code's own code (2.1.258). PreCompact passes each successful hook's stdout to the compactor as custom instructions (Claude Code also shows that text in the transcript as "PreCompact … completed successfully"); PostCompact receives `compact_summary`; every hook receives `session_id`, `transcript_path` and `cwd`; SessionStart sources are `startup`, `resume`, `clear`, `compact` and `fork`.

Wrap anything in `<private>…</private>` and it never reaches memory. Turn hooks off without editing files: `GITHIPPO_HOOK_PROFILE=minimal` or `GITHIPPO_DISABLED_HOOKS=prompt,steer`.

## Token budget (measured, `githippo bench`)

| | v2 (naive) | **githippo** |
|---|---|---|
| Tools | 12 | **8** |
| Model-visible schema, every turn | ~1,380 tok | **~760 tok** |
| Instructions | ~340 tok | **~176 tok** + your core |
| Typical recall response | ~190 tok (JSON) | **~117 tok** pack / **~47 tok** brief |

How: terse schemas, the redundant `$schema` URL stripped from `tools/list`, compact text responses instead of pretty JSON, wikilinks rendered as plain words, frontmatter stripped, 8-char version handles, History/index/sessions/core excluded from recall by default, and token budgets on every pack.

## Tools

| Tool | What it does |
|---|---|
| `recall` | Hybrid search (BM25 + embeddings, fused with reciprocal rank fusion) + one-hop graph expansion → token-budgeted context pack. `mode=brief` for refs only |
| `remember` | Save a fact. Auto-routes to the right entity, dedupes, auto-links people/projects, flags what it may supersede. `replaces=` supersedes, `pin=` adds to core |
| `forget` | Remove an exact fact |
| `graph` | Typed relations around an entity |
| `history` | Commit timeline, or the file as of a date |
| `checkpoint` | Save or resume working state |
| `maintain` | Duplicates, possible contradictions, orphans, broken links, stale inbox; rebuild index; activity-aware decay; LLM merge |
| `files` | Raw list/read/write/edit/delete with version checks |

## Setup

**Claude Code** (full experience: hooks + MCP)

```bash
curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/install.sh | sh
```

Prefer to see what runs? It's [a short shell script](install.sh): check Node 20+, `npm i -g github:AnxovatomicaES/githippo#v3.2.0`, then `githippo setup`. `setup` is idempotent, keeps any status line you already have, and backs up `~/.claude/settings.json` before touching it. `githippo doctor` checks everything afterwards.

Plugin route: run the install above, then `/plugin marketplace add AnxovatomicaES/githippo` and `/plugin install githippo`. Or hand your agent [`INSTALL_FOR_AGENTS.md`](INSTALL_FOR_AGENTS.md).

<details><summary><b>Claude Desktop</b></summary>

Install as above, then add to `~/Library/Application Support/Claude/claude_desktop_config.json` and restart:

```json
{ "mcpServers": { "githippo": { "command": "githippo", "args": ["serve"] } } }
```

No environment variables needed: it uses the same local vault as Claude Code.
</details>

<details><summary><b>Backup and sync across machines</b></summary>

```bash
githippo sync --github            # creates a private repo "githippo-memory" with your gh login
```

Every change is pushed in the background; the server pulls other machines' changes every 5 minutes. On a second machine: `git clone` the repo to `~/.githippo/vault`, then run the installer. No token is stored anywhere: git uses your existing GitHub CLI, SSH or keychain login.
</details>

<details><summary><b>claude.ai, iOS and Android</b> (remote)</summary>

The phone and web apps can't reach your laptop, so this mode reads the vault from GitHub:

1. `githippo sync --github` (above).
2. Click **Deploy to Render** at the top and set `MEMORY_REPO` (e.g. `you/githippo-memory`) and `GITHUB_TOKEN`: a fine-grained token limited to that one repo with *Contents: Read and write*. `MCP_SECRET` is generated for you.
3. In claude.ai: Settings → Connectors → Add custom connector → `https://<your-app>.onrender.com/mcp/<MCP_SECRET>`.
</details>

<details><summary><b>Cursor, Windsurf, VS Code, any MCP client</b></summary>

Local: command `githippo serve`. Remote: URL `https://host/mcp` with header `Authorization: Bearer <MCP_SECRET>`.
</details>

## Memory format

Plain Markdown, Obsidian-compatible. Open the repo as a vault and you get the graph view for free.

```markdown
---
name: billing-v2
title: Billing v2
type: project
description: Billing rewrite
aliases: [billing rewrite]
---

## Decisions
- Use idempotency keys on every write endpoint
- owner:: [[sam-okafor]]
- Launch target is end of Q1

## History
- ~~Launch target is end of Q4~~ (until 2026-09-30)
```

Layout: `core.md` (pinned), `index.md` (table of contents), `inbox.md` (unrouted facts), `people/`, `projects/`, `topics/`, `decisions/`, `sessions/` (checkpoints). See [`examples/memory`](examples/memory).

## Configuration

| Variable | Default | |
|---|---|---|
| `VAULT_DIR` | `~/.githippo/vault` | local memory vault (a git repo) |
| `STORE` | `local` | `github` reads/writes via the GitHub API instead (used by the remote server) |
| `GITHUB_TOKEN`, `MEMORY_REPO` | | only for `STORE=github` / remote mode |
| `MCP_SECRET` | | remote mode, 24+ chars |
| `EMBEDDINGS` | `local` | `local` (paraphrase-multilingual-MiniLM-L12-v2, CPU, one-time model download, ~860 MB RAM), `voyage`, or `none` (keyword only). Choice and thresholds are measured in [docs/calibration.md](docs/calibration.md) |
| `MEMORY_ROOT` / `MEMORY_BRANCH` | `memory` / `main` | |
| `CORE_BUDGET_TOKENS` | `400` | hard cap for pinned memory |
| `PROMPT_RECALL` | `1` | `0` turns off the per-prompt hook |
| `ANTHROPIC_API_KEY` | | only for `maintain rewrite=` |
| `VOYAGE_API_KEY` | | for `EMBEDDINGS=voyage` |

## Security model, honestly

- **Your files, your data.** githippo has no backend. Memory lives in a folder on your machine; backup goes to a **private** repo you own (`doctor` warns if it isn't private).
- **No stored token for local use.** Sync uses git's existing login (GitHub CLI, SSH or keychain). Only the remote server needs a token: make it fine-grained, one repo, Contents read/write only.
- **Remote auth** is a high-entropy secret in the URL or a Bearer header, compared in constant time and rate limited. Treat the connector URL like a password. OAuth 2.1 is on the roadmap.
- **The guard is a backstop, not DLP.** It catches common secret and ID formats. `forget` removes a line from the current file, but git history keeps it; purging needs a history rewrite.
- **Hooks never break your session.** Every failure path exits 0 with a short timeout.

## Develop

```bash
npm ci && npm test      # 70 tests: unit, hooks, adopted features, bug regressions, local vault, setup, end-to-end over Streamable HTTP with the official MCP client
npm run bench           # token cost of the tool surface
```

## Roadmap

OAuth 2.1 for remote · MCP Registry listing · Claude Desktop extension bundle · usage-weighted ranking · multi-user vaults with per-folder ACLs

MIT licensed. PRs welcome.
