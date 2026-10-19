# Benchmarks

A labelled benchmark ships in [`eval/`](../eval): a 19-file working memory (people, projects, decisions; some notes in Spanish) and 52 queries labelled with the file that should come back, plus filing and duplicate/update cases. CI runs it on every change to the code and posts the results to [issue #3](https://github.com/AnxovatomicaES/githippo/issues/3); a quality floor fails the build if keyword retrieval regresses. Reproduce it with `githippo eval`.

| Queries (52) | Keyword + graph | + local model |
|---|---|---|
| Exact terms, code identifiers, names, graph hops (21) | 100% hit@1 | 100% hit@1 |
| Paraphrases (12) | 50% hit@1 · 67% hit@5 | 58% hit@1 · 100% hit@5 |
| Spanish ↔ English (13) | 15% hit@1 · 23% hit@5 | 54% hit@1 · 100% hit@5 |
| French, German, Portuguese, Italian → English (6) | 17% hit@5 | 100% hit@1 |
| **All** | **58% hit@1 · 64% hit@5 · MRR 0.60** | **79% hit@1 · 100% hit@5 · MRR 0.89** |
| Filing a new fact in the right file (12, held out) | 67%, none in a wrong file | 67%, none in a wrong file |
| Duplicate vs update vs new fact (11) | 91% | 82% |

hit@k: the right file is among the first k results. Recall puts several results in context, so with the model the right memory reached Claude in all 52 cases; every miss at rank 1 was at rank 2.

What this does and doesn't tell you: the set is small, hand-written by the author, and in-domain, so treat it as a regression guard and a rough guide, not a leaderboard number. Filing is the weakest area. It's deliberately cautious: when the evidence is a tie it parks the fact in the inbox (visible, one move away) rather than guessing, so a third of held-out facts wait in the inbox but none go to a wrong file. Filing rules were tuned on a separate development set (90% there, 2 of 20 in a wrong file) and the held-out number is reported as measured; it went down from 75% when the rules changed, in exchange for no wrong-file errors. Thresholds were calibrated on separate sentence pairs ([docs/calibration.md](calibration.md)), not tuned on this set.

## Public benchmark: LongMemEval-S

[LongMemEval](https://arxiv.org/abs/2410.10813) (ICLR 2025) is a public long-term-memory benchmark: 500 questions, each with about 48 past chat sessions to search. githippo runs it with the same retrieval protocol [agentmemory publishes](https://github.com/rohitg00/agentmemory/blob/main/benchmark/LONGMEMEVAL.md) (fresh index per question, recall_any@K over sessions, retrieval only, no LLM), on a pinned dataset revision, weekly in CI ([`eval/longmemeval.js`](../eval/longmemeval.js), results in [#3](https://github.com/AnxovatomicaES/githippo/issues/3)).

| LongMemEval-S, 500 questions | R@5 | R@10 | R@20 | MRR |
|---|---|---|---|---|
| githippo, keyword + graph (no model) | **96.2%** | 98.4% | 99.2% | 91.5 |
| same, sessions shuffled (sanity check) | 96.2% | 98.4% | 99.2% | 91.5 |
| ablation: chunks only, no document-level evidence | 96.0% | 98.0% | 99.2% | 90.4 |
| ablation: whole-session documents instead of chunks | 97.4% | 98.2% | 99.6% | 91.1 |
| *for reference: agentmemory BM25 / BM25 + vectors (their published numbers, all 500)* | *86.2% / 95.2%* | *94.6% / 98.6%* | | |

The local model is too slow on CI hardware for all 500 questions (about 46 chunks a second, so 2+ hours), so it runs on an evenly spaced 100-question sample that keeps the question-type mix, next to keyword search on the same 100:

| LongMemEval-S, same 100 questions | R@5 | R@10 | R@20 | MRR |
|---|---|---|---|---|
| githippo, keyword + graph | 97.0% | 98.0% | 98.0% | 92.6 |
| githippo, + local multilingual model | **98.0%** | **99.0%** | **100%** | **95.3** |

The model helps where keyword search is weakest: preference questions go from 83% to 100% at R@10. This first sampled run predates the check that confirms every question got semantic results; later runs in #3 include it.

Read it carefully: this is retrieval recall, not the official LongMemEval QA score (which needs an LLM to answer and a judge). Shuffling the sessions changes nothing, so the score isn't an ordering artifact. githippo's keyword search scores well above agentmemory's published keyword number under the same protocol; the difference is in tokenization and ranking details we haven't isolated, so treat cross-project comparisons as indicative and reproduce them yourself. Whole sessions beat ~700-character chunks on R@5 here, which led to one design change: githippo now also ranks whole notes and fuses that with chunk evidence (best MRR of the variants, chunk-level references kept). That change was evaluated on this benchmark, so LongMemEval is no longer fully held out for it; the in-repo eval didn't change.

## Resources and scale

**Resources** (measured in CI, Linux): githippo itself uses about 50 MB. The local model runs in a separate process that uses about 520 MB while you're using it and exits after 10 idle minutes (`EMBED_IDLE_MS`), so an idle githippo is back to about 50 MB. Without the model (`EMBEDDINGS=none`) it never goes above about 100 MB. The model embeds about 46 chunks a second on a 4-core CI machine (batch size and thread count make no difference), so the first semantic index of a 5,000-note vault takes a few minutes; it happens once in the background, vectors are cached on disk, and keyword search works in the meantime.

**Scale** (local vault, keyword index, measured on Linux): 5,000 notes: cold index 1.3 s, query 23 ms, `remember` 0.06–0.1 s, 149 MB RAM. 20,000 notes: 4.7 s, 41 ms, 0.17–0.2 s, 315 MB. 50,000 notes: 12.4 s, 78 ms, 0.5–0.7 s, 541 MB. A write re-tokenises only the note it touches (an inverted index with incremental add/remove), queries pick the top results from postings, and the semantic vector cache is a binary file: 77 MB, written in 0.14 s and loaded in 0.09 s at 50,000 chunks of 384 dimensions (it was 162 MB of JSON with a 6 s write that blocked the server). The trade-off: cold start is about 50% slower than the old full-scan index (12 s vs 8 s at 50,000 notes). Ranking is unchanged: LongMemEval gives identical numbers before and after. A personal memory rarely passes a few thousand notes; a database isn't needed at these sizes.

## What a question costs as memory grows

`node eval/scale-context.js` (or `npm run bench:scale`) builds vaults of 100 to 30,000 synthetic notes (people and projects with 4 to 8 facts each, written with the overlapping vocabulary real notes have: many people "prefer written RFCs", many projects "decided to use Postgres") and plants 40 questions of two kinds: **named** ("What does Sam Okafor say about the billing migration?": a full name plus a topic word) and **needle** ("What did we decide for the zorvakel migration?": a rare codename plus a topic word that hundreds of notes share). It reports what a model has to read, against loading the whole memory into the context. Keyword mode, no model, one Apple-silicon laptop, seed 7:

| notes | loading everything | recall pack (mean) | recall brief (mean) | pack is smaller by | named: fact in pack | needle: fact in pack | needle hit@1 | query (median) | cold index |
|---|---|---|---|---|---|---|---|---|---|
| 100 | 7,306 tok | 564 tok | 266 tok | 12.9x | 100% | 100% | 100% | 0 ms | 15 ms |
| 1,000 | 68,130 tok | 544 tok | 272 tok | 125.1x | 100% | 100% | 100% | 0 ms | 42 ms |
| 10,000 | 672,866 tok | 565 tok | 267 tok | 1,191.5x | 100% | 100% | 100% | 1 ms | 379 ms |
| 30,000 | 2,021,230 tok | 557 tok | 263 tok | 3,626.5x | 100% | 100% | 100% | 3 ms | 1,187 ms |

Read it for what it is: the context a question costs stays flat (about 550 tokens as a pack, about 265 as a brief) while the memory it comes from grows 300-fold, and a rare identifier stays findable in it. "Fact in pack" means the exact fact text reached the model, which is stricter than "the right note ranked first".

What it does **not** show: paraphrases (keyword mode has no way to bridge "the language I prefer" and "TypeScript"; see the table at the top for that), real notes, or whether the answer is any better for having been found. Names and rare codenames are the easy case for keyword search, which is the point of a scale test: it asks whether cost and recall *hold* as the haystack grows, not how good recall is in the first place. Loading everything is only a baseline for the cost axis: past a few thousand notes it doesn't fit in any context window.

This benchmark found a real bug: with usage learning on (the default), rank-1 accuracy on the needle questions fell from 100% to about 35% after a few dozen queries, because the usage boost was applied after rank fusion, where scores differ by 1 to 3% from one rank to the next. It is now applied to the raw scores (see the README), and `test/report6-ranking.test.js` guards it.

