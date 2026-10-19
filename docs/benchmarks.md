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

## A harder paraphrase set: no shared words

The 12 paraphrases in the table at the top are easy to match by accident: several share a word with the note ("invoices", "customer", "database"), and the vault has 19 notes. `node eval/paraphrase.js` (or `npm run bench:paraphrase`) runs a set built to remove that: 119 notes in five domains (an engineering team, sales, personal life, a research lab, a small business), each with two English questions about different facts and one Spanish question. Every English query was checked after stemming (`violations()` in [`eval/paraphrase.js`](../eval/paraphrase.js), guarded by `test/paraphrase.test.js`): it shares **no content word with its note** except the entity's own name, so keyword search has nothing to match on and only meaning can find the note. Notes and queries were written by five Claude Sonnet 5.5 subagents (one domain each) from a fixed brief; of the queries for the 119 kept notes, 9 failed the check and were dropped, and one note was dropped for repeating another note's path. Local, no API key, about 4 seconds with the model. Hit@k is over the files recall returns for the query.

| 348 queries over 119 notes | keyword + graph | + paraphrase-multilingual-MiniLM-L12-v2 (the default local model) | + EmbeddingGemma-300M, q4 (opt-in) |
|---|---|---|---|
| English paraphrases (229) | 24.9% hit@1 · 55.9% hit@5 · MRR 0.375 | 42.4% hit@1 · 65.5% hit@5 · MRR 0.530 | 50.2% hit@1 · 69.0% hit@5 · MRR 0.588 |
| Spanish questions (119) | 44.5% hit@1 · 54.6% hit@5 · MRR 0.488 | 70.6% hit@1 · 84.9% hit@5 · MRR 0.772 | 82.4% hit@1 · 97.5% hit@5 · MRR 0.894 |
| **All** | **31.6% hit@1 · 55.5% hit@5 · MRR 0.413** | **52.0% hit@1 · 72.1% hit@5 · MRR 0.613** | **61.2% hit@1 · 78.7% hit@5 · MRR 0.692** |

What it shows: when a question shares no words with the note, the right note is first for about a quarter of English questions with keyword search, two in five with the default model and one in two with EmbeddingGemma; with the default model it is missing from the top five for a third. That is much lower than the 100% hit@5 of the paraphrase row at the top, which is why the top row should not be read as "paraphrases are solved". The weakest domain is small-business notes (42.6% hit@1 with the model, 27.9% without), where many notes share the same shape (terms, schedules, limits); with keyword search sales is nearly as weak.

**EmbeddingGemma, what it costs.** Google's EmbeddingGemma-300M (2025; 768 dimensions, a 2,048-token window against MiniLM's 128, 100+ languages) is supported as an opt-in (`LOCAL_EMBED_MODEL=onnx-community/embeddinggemma-300m-ONNX`, see [configuration](configuration.md)); it is not the default. Measured on the same laptop (192 chunks of 700 characters, a single run each, so read the ratios, not the digits):

| | MiniLM (default) | EmbeddingGemma q4 |
|---|---|---|
| Download | 129 MB | 209 MB |
| Indexing | 116 chunks/s | 23 chunks/s (5× slower) |
| One query | 3 ms | 13 ms |
| Worker memory | 878 MB | 741 MB |
| In-repo eval, all 52 queries | 78.8% hit@1 · 100% hit@5 · MRR 0.884 | 80.8% · 100% · 0.898 |
| In-repo filing, held-out | 66.7% of 12 | 66.7% of 12 |
| In-repo duplicate / update / new | 81.8% of 11 | 72.7% of 11 |

Keeping the first 256 of the 768 dimensions (Matryoshka truncation, `GITHIPPO_EMBED_DIMS=256`) gives 60.6% hit@1 · 77.0% hit@5 on all queries (English unchanged at 51.1% · 68.1%, Spanish hit@5 94.1%): a third of the vector storage for 1.7 points of hit@5. At 512 it is 59.5% · 78.7%, at 128 it is 59.2% · 75.9%.

Why it is not the default yet: a vault of a few thousand chunks takes minutes to index instead of seconds (in the background; keyword search works meanwhile), changing the default re-embeds everyone's vault, the Gemma licence is not an open-source one, and the LongMemEval sample has not been run with it (that needs the dataset downloaded). The duplicate/update/new row is the one place it is worse. It is calibrated on the same sentence pairs as MiniLM ([calibration](calibration.md)).

Read it carefully:
- **Spanish scores higher than English with keyword search (44.5% against 24.9%)** because a Spanish question usually contains the entity's name or a technical term that is the same in both languages ("Redis", "Atlas"); only the English questions were checked for shared words. Treat the Spanish rows as "across languages, names allowed", not as pure paraphrase.
- **The data is generated, by a model from the same family as the one that uses the tool.** The notes are short and tidy, the questions are fluent, and there are 119 notes: real notes are messier and there are more of them. It was not tuned against retrieval results; treat it as a way to compare retrieval settings and models on one yardstick, not as a leaderboard number.
- The overlap check is a stemming heuristic: a few queries that a human would call a paraphrase were dropped for sharing a stem ("plane" and "plan"), and a few synonyms that are cognates may remain.

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


## A/B pilot: does an answer need the memory, and what does finding it cost?

`eval/ab-setup.js`, `eval/ab-recall.js` and `eval/ab-score.js` run a small A/B on the same synthetic vault as the scale test (150 notes, seed 11). 12 questions: 6 **needle** ("What technology did we decide to use for the necocumu rollout?") and 6 **preference** ("What does Mei Zoveku prefer to use for communicating, and over what?"). Each question went to a fresh Claude Haiku subagent, one question per agent, in one of four arms. An answer counts as right when it contains the expected phrase (case-insensitive); the answers are kept in a file the agents never saw.

| arm | what the agent could do |
|---|---|
| A | nothing: no notes, answer from knowledge |
| B | githippo recall only (`eval/ab-recall.js`, keyword index) |
| C | read the whole memory in one file (about 7 thousand tokens at 150 notes) |
| D | search the note files itself with Grep, Glob, Read or `grep` |

| arm | correct | accuracy (95% Wilson interval) | mean tokens per question | mean tool calls |
|---|---|---|---|---|
| A | 0/12 | 0% (0-24%) | 68,056 | 1 |
| B | 12/12 | 100% (76-100%) | 69,436 | 2.3 |
| C | 12/12 | 100% (76-100%) | 85,185 | 2 |
| D | 12/12 | 100% (76-100%) | 71,947 | 3.7 |

About 68 thousand tokens of every figure is the fixed overhead of starting a subagent (arm A pays only that), so the cost of finding the answer is the difference from A: **recall +1.4k, searching files +3.9k, reading everything +17.1k**.

What this shows: at 150 notes, recall found every planted fact and cost the least of the arms that could look (2.3 tool calls, against 3.7 for searching files; reading one file takes 2). Reading everything cost about 12 times as much as recall for the same accuracy, and that gap grows with the vault (see the scale table above).

What it does **not** show, and the reasons not to read more into it:
- **A is a sanity check, not a result.** The facts are invented, so no model can know them: 0% is the expected value, and it only proves the questions can't be answered without the notes. Whether memory improves answers about real work is still not measured.
- **B, C and D are tied.** 12 of 12 each; with 12 questions the interval is 76-100%, so a difference of one or two answers would be invisible. The token and tool-call gaps are one run each, with no repeats.
- **The questions are the easy case.** Full names and rare codenames; a file search finds them as well as recall does. Paraphrases ("the language I prefer" for "TypeScript") are not tested; the LongMemEval table at the top is where that is measured.
- **B is a proxy for the MCP tool.** The agent ran a script that calls the same recall code over an in-memory keyword index, not the MCP server, so B does not pay the tool schema that `githippo bench` measures (about 790 tokens per turn). Add that to B for a fair comparison in a real session.
- **Restrictions were given as instructions** ("use only this command"), not enforced; the tool-call counts suggest they were followed.
- **One small model, one seed, one vault, synthetic notes.** A "preference" note can also be self-referential (the generator can write "design docs over design docs"); the scorer accepts it by containment.
- Subagent token counts include the agent's own start-up, so only differences between arms mean anything.

To repeat it: `node eval/ab-setup.js --size 150 --questions 12 --seed 11 --out <dir>`, give each question to a fresh agent per arm with the file paths above, save each answer as `<dir>/answers/<arm>-<qid>.txt`, put the token and tool counts in `<dir>/usage.json` as `{"<arm>-<qid>": {"tokens": n, "tools": n}}`, then `node eval/ab-score.js <dir>`. A fairer next step needs an API key and more of what is still missing: paraphrased questions, several seeds, and the real MCP server (a ten times bigger vault is in the next section).

### The same pilot at 1,500 notes

Same method, one more vault: 1,500 notes (seed 12; the memory file is about 88 thousand tokens), 24 questions (12 needle, 12 preference), arms B and D only. A was not repeated (the facts are invented, so it stays at 0%) and C was skipped (reading 88 thousand tokens a question needs no new evidence). Commands: `node eval/ab-setup.js --size 1500 --questions 24 --seed 12 --out <dir>`, then as above.

| arm | correct | accuracy (95% Wilson interval) | mean tokens per question | median | mean tool calls |
|---|---|---|---|---|---|
| B: githippo recall | 24/24 | 100% (86-100%) | 69,898 | 69,760 | 2.7 |
| D: search the files | 24/24 | 100% (86-100%) | 72,963 | 71,019 | 4.1 |

Against the 68,056-token baseline of the 150-note pilot (arm A there; this run has no A of its own, so the baseline is borrowed), finding the answer cost **+1.8k tokens with recall and +4.9k searching files**, up from +1.4k and +3.9k at 150 notes. A vault ten times bigger added about 0.4k to recall and about 1.0k to the file search. The file search also had a tail: three of its 24 questions cost between 80.6k and 84.6k tokens (+12k to +16k, up to about what reading the whole 150-note memory cost), where recall's most expensive question was 71.7k. Outside a deterministic check (below) these are single runs.

A free check ran before any agent: for each of the 24 questions the recall pack contained the exact expected fact (24/24) at 540 to 600 tokens for a needle question and 375 to 440 for a preference one, in 0.2 s for a whole script run (start-up, indexing 1,500 notes and one query). The agents therefore tested reading and answering, not retrieval.

Caveats specific to this run:
- **4 of the 12 preference questions have a circular answer.** The note generator can write "short standups over short standups" (102 of 750 preference lines in this vault); a person whose note says that has no alternative channel to report. Both arms answered those four with the circular sentence or a hedged version of it (D's answer for Tess Purohi says the notes name no channel and quotes "design docs over design docs"), and the scorer accepts them by containment. Without those four, both arms are 20/20. The generator is `buildVault` in `eval/scale-context.js`, shared with the scale test; it is not changed here so that the published numbers stay reproducible.
- **Still ties.** 24/24 against 24/24 cannot separate the arms on accuracy, and the questions are still the easy case for keyword search (a full name or a rare codename). The usual caveats above apply: Haiku only, one seed, restrictions by instruction, B is the recall code as a script and not the MCP tool.
