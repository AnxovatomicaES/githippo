<p align="center">
  <img src="https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/assets/banner.svg" alt="githippo, a hippocampus for your AI" width="100%">
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
  <img src="https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/assets/demo.svg" alt="githippo surviving a context compaction in Claude Code" width="100%">
</p>

Long-term memory for Claude and any MCP client, stored as plain Markdown in a git repo **you own**. Hybrid semantic search, a knowledge graph, auto-memory and compaction survival, at about 760 tokens of tool overhead per turn. Every memory is a git commit you can read, diff and revert.

```bash
curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/install.sh | sh
```

That's the whole install: no account, no token, no questions. It sets up a local memory vault, wires Claude Code (hooks, MCP, status line) and fetches semantic search in the background. Restart Claude Code and just talk; it remembers.

Want it backed up and synced across machines? `githippo sync --github` creates a private repo with your existing GitHub CLI login and pushes after every change. Just curious? `npx -y github:AnxovatomicaES/githippo#v3.4.0 demo` shows it working in 30 seconds without installing anything.

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

Version 3.1 adds the best idea from each of nine other memory tools, read in their source and credited in [docs/prior-art.md](https://github.com/AnxovatomicaES/githippo/blob/main/docs/prior-art.md): `<private>` tags, compaction steering and summary capture, session diffing, activity-aware decay, a code-aware tokenizer, errors in checkpoints, an honest status line, plugin packaging and `alwaysLoad` registration.

What else it does:

- **Compliance guard.** Blocks API keys, tokens, private keys, IBANs (mod-97 checked), card numbers (Luhn checked), Spanish DNI/NIE (checksum) and US SSNs *before* they become permanent git history.
- **Compaction-proof by design**, three ways (see below).
- **Cross-lingual recall.** The default multilingual embedder runs locally; ask in Spanish, find notes written in English.
- **Updates are never mistaken for duplicates.** "Launch is end of Q1" and "end of Q2" embed almost identically. githippo also compares numbers, dates and names, so the update is saved, the old line is flagged, and `maintain` reports possible contradictions. Measured in [docs/calibration.md](https://github.com/AnxovatomicaES/githippo/blob/main/docs/calibration.md).
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

Recall also learns what you actually use: memory that keeps being handed to Claude gets a small boost (at most +40%) that halves every 30 days without use. The counts stay on your machine, are kept per user, and with no usage data ranking is exactly the same as without it.

Wrap anything in `<private>…</private>` and it never reaches memory. Turn hooks off without editing files: `GITHIPPO_HOOK_PROFILE=minimal` or `GITHIPPO_DISABLED_HOOKS=prompt,steer`.

## Quality, measured

A labelled benchmark ships in [`eval/`](https://github.com/AnxovatomicaES/githippo/tree/main/eval): a 19-file working memory (people, projects, decisions; some notes in Spanish) and 52 queries labelled with the file that should come back, plus filing and duplicate/update cases. CI runs it on every change to the code and posts the results to [issue #3](https://github.com/AnxovatomicaES/githippo/issues/3); a quality floor fails the build if keyword retrieval regresses. Reproduce it with `githippo eval`.

| Queries (52) | Keyword + graph | + local model |
|---|---|---|
| Exact terms, code identifiers, names, graph hops (21) | 100% hit@1 | 100% hit@1 |
| Paraphrases (12) | 42% hit@1 · 67% hit@5 | 58% hit@1 · 100% hit@5 |
| Spanish ↔ English (13) | 15% hit@1 · 23% hit@5 | 54% hit@1 · 100% hit@5 |
| French, German, Portuguese, Italian → English (6) | 17% hit@5 | 100% hit@1 |
| **All** | **56% hit@1 · 64% hit@5 · MRR 0.59** | **79% hit@1 · 100% hit@5 · MRR 0.89** |
| Filing a new fact in the right file (12) | 75% | 75% |
| Duplicate vs update vs new fact (11) | 91% | 82% |

hit@k: the right file is among the first k results. Recall puts several results in context, so with the model the right memory reached Claude in all 52 cases; every miss at rank 1 was at rank 2.

What this does and doesn't tell you: the set is small, hand-written by the author, and in-domain, so treat it as a regression guard and a rough guide, not a leaderboard number. Filing is the weakest area: a quarter of facts land in the inbox or the wrong file, and the model doesn't help. Thresholds were calibrated on separate sentence pairs ([docs/calibration.md](https://github.com/AnxovatomicaES/githippo/blob/main/docs/calibration.md)), not tuned on this set.

**Resources** (measured in CI, Linux): githippo itself uses about 50 MB. The local model runs in a separate process that uses about 520 MB while you're using it and exits after 10 idle minutes (`EMBED_IDLE_MS`), so an idle githippo is back to about 50 MB. Without the model (`EMBEDDINGS=none`) it never goes above about 100 MB.

**Scale:** a 5,000-file local vault re-syncs in about 0.3 s and answers a query in about 13 ms. In GitHub mode (the remote server), a 2,000-file vault cold-starts with 2 API calls (one tarball), an unchanged sync is a free `304 Not Modified`, and each write is 1 call.

## Should you use githippo?

- **Claude's built-in memory** is the zero-setup choice. Use githippo if you want the memory as files you can read, diff, edit in Obsidian and back up yourself, the same memory across Claude Code, Claude Desktop, claude.ai and other MCP clients, or memory that survives Claude Code's context compaction.
- **[basic-memory](https://github.com/basicmachines-co/basic-memory)** is the closest alternative: also Markdown and Obsidian-friendly, more mature, Python, AGPL. githippo differs in git history and time travel, the compaction hooks, OAuth team vaults with folder permissions, and a secrets guard.
- **[mem0](https://github.com/mem0ai/mem0)** and other hosted services extract facts with an LLM and store them in their cloud, with nothing to run. githippo never calls an LLM to save a fact and keeps everything in a repo you own.
- **It's young.** githippo is a single-maintainer project with a few weeks of history. The benchmark, 80+ tests and the bug log in the commit history are there so you can judge it, but expect rough edges.

## Token budget (measured, `githippo bench`)

| | githippo v2 (our first version) | **githippo now** |
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

Prefer to see what runs? It's [a short shell script](https://github.com/AnxovatomicaES/githippo/blob/main/install.sh): check Node 20+, `npm i -g github:AnxovatomicaES/githippo#v3.4.0`, then `githippo setup`. `setup` is idempotent, keeps any status line you already have, and backs up `~/.claude/settings.json` before touching it. `githippo doctor` checks everything afterwards.

Plugin route: run the install above, then `/plugin marketplace add AnxovatomicaES/githippo` and `/plugin install githippo`. Or hand your agent [`INSTALL_FOR_AGENTS.md`](https://github.com/AnxovatomicaES/githippo/blob/main/INSTALL_FOR_AGENTS.md).

<details><summary><b>Claude Desktop</b> (one-click extension)</summary>

Download `githippo-<version>.mcpb` from the [latest release](https://github.com/AnxovatomicaES/githippo/releases/latest) and double-click it (or drag it into Settings → Extensions). It runs on Claude Desktop's built-in Node, so nothing else needs installing, and it uses the same vault as the CLI and Claude Code. Also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.AnxovatomicaES/githippo`.
</details>

<details><summary><b>Backup and sync across machines</b></summary>

```bash
githippo sync --github            # creates a private repo "githippo-memory" with your gh login
```

Every change is pushed in the background; the server pulls other machines' changes every 5 minutes. On a second machine: `git clone` the repo to `~/.githippo/vault`, then run the installer. No token is stored anywhere: git uses your existing GitHub CLI, SSH or keychain login.
</details>

<details><summary><b>claude.ai, iOS and Android</b> (remote, OAuth 2.1, multi-user)</summary>

The phone and web apps can't reach your laptop, so this mode reads the vault from GitHub:

1. `githippo sync --github` (above).
2. Click **Deploy to Render** at the top. Set `MEMORY_REPO` (e.g. `you/githippo-memory`), `GITHUB_TOKEN` (fine-grained, that one repo, *Contents: Read and write*) and `PUBLIC_URL` (your service's https URL). `MCP_SECRET` is generated for you.
3. In claude.ai: Settings → Connectors → Add custom connector → `https://<your-app>.onrender.com/mcp`. Claude registers itself and opens a sign-in page; enter `MCP_SECRET` once. That's standard OAuth 2.1 (PKCE, dynamic client registration, audience-bound tokens), so nothing secret ever sits in a URL.

**A shared vault for a team.** Add people with folder-level access; each signs in with their own password:

```bash
githippo users add john --acl "shared/:write,people/:read"   # prints his password once
githippo users list
```

Rules use the longest matching folder (`none`, `read`, `write`). Everyone also gets a private `users/<id>/` folder for their own inbox, sessions and pinned core memory, which a catch-all rule can never open. Facts a user can't write where they'd naturally go land in their own inbox instead. Every commit records who made it. Changing a password or ACL revokes that user's tokens immediately. On hosts without a disk, paste `~/.githippo/users.json` into the `USERS_JSON` variable.
</details>

<details><summary><b>Cursor, Windsurf, VS Code, any MCP client</b></summary>

Local: command `githippo serve`. Remote: URL `https://host/mcp`; clients that support MCP OAuth sign in by themselves, others can send `Authorization: Bearer <MCP_SECRET>` (a header, so it doesn't end up in URL logs).
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

Layout: `core.md` (pinned), `index.md` (table of contents), `inbox.md` (unrouted facts), `people/`, `projects/`, `topics/`, `decisions/`, `sessions/` (checkpoints). See [`examples/memory`](https://github.com/AnxovatomicaES/githippo/tree/main/examples/memory).

## Configuration

| Variable | Default | |
|---|---|---|
| `VAULT_DIR` | `~/.githippo/vault` | local memory vault (a git repo) |
| `STORE` | `local` | `github` reads/writes via the GitHub API instead (used by the remote server) |
| `GITHUB_TOKEN`, `MEMORY_REPO` | | only for `STORE=github` / remote mode |
| `MCP_SECRET` | | remote mode, 24+ chars: owner login and OAuth signing key |
| `PUBLIC_URL` | | remote mode: the server's public https URL (OAuth issuer) |
| `USERS_JSON` | | remote multi-user: contents of `githippo users` file |
| `EMBEDDINGS` | `local` | `local` (paraphrase-multilingual-MiniLM-L12-v2 in a separate process: ~520 MB while in use, exits after `EMBED_IDLE_MS`, default 10 min), `voyage`, or `none` (keyword only). Choice and thresholds are measured in [docs/calibration.md](https://github.com/AnxovatomicaES/githippo/blob/main/docs/calibration.md) |
| `MEMORY_ROOT` / `MEMORY_BRANCH` | `memory` / `main` | |
| `CORE_BUDGET_TOKENS` | `400` | hard cap for pinned memory |
| `PROMPT_RECALL` | `1` | `0` turns off the per-prompt hook |
| `ANTHROPIC_API_KEY` | | only for `maintain rewrite=` |
| `VOYAGE_API_KEY` | | for `EMBEDDINGS=voyage` |

## Security model, honestly

- **Your files, your data.** githippo has no backend. Memory lives in a folder on your machine; backup goes to a **private** repo you own (`doctor` warns if it isn't private).
- **No stored token for local use.** Sync uses git's existing login (GitHub CLI, SSH or keychain). Only the remote server needs a token: make it fine-grained, one repo, Contents read/write only.
- **Remote auth is OAuth 2.1** (PKCE S256 only, dynamic client registration, single-use codes, tokens bound to the `/mcp` resource and to the user's current password and ACL). It's stateless: everything is HMAC-signed, so restarts don't log anyone out. The old secret-in-URL (`/mcp/<secret>`) is off unless `LEGACY_SECRET_URL=1`, because URLs end up in proxy logs. Login attempts are rate limited and every response is constant-time.
- **The guard is a backstop, not DLP.** It catches common secret and ID formats. `forget` removes a line from the current file, but git history keeps it; purging needs a history rewrite.
- **Hooks never break your session.** Every failure path exits 0 with a short timeout.

## Develop

```bash
npm ci && npm test      # 80 tests: unit, hooks, adopted features, bug regressions, local vault, setup, end-to-end over Streamable HTTP with the official MCP client
npm run bench           # token cost of the tool surface
```

## Roadmap

Signed `.mcpb` releases · usage-aware decay (combine ranking signals with `maintain decay`) · SSO (GitHub/Google) as an OAuth identity provider for team vaults

MIT licensed. PRs welcome.
