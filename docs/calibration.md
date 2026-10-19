# Embedding model choice and threshold calibration

Measured on a Mac mini (Apple Silicon, Node 25), transformers.js, q8 weights, 2026-10-17.

## Model comparison

Eight notes in English, ten queries (six in Spanish, four English paraphrases). "Margin" is the average gap between the correct note and the best wrong one, which is what every threshold in githippo depends on.

| Model | Top-1 | Correct avg | Wrong avg | Margin | ms/query | RSS |
|---|---|---|---|---|---|---|
| multilingual-e5-small | 8/10 | 0.783 | 0.720 | 0.031 | 2 | 748 MB |
| **paraphrase-multilingual-MiniLM-L12-v2** (default) | 8/10 | 0.406 | 0.092 | **0.144** | 2 | 858 MB |
| multilingual-e5-base | 9/10 | 0.770 | 0.704 | 0.037 | 8 | 1,078 MB |

e5 models rank well but compress every score into a narrow high band, so a wrong note often scores above an average correct one and no fixed threshold can separate them. MiniLM separates them by about 5×.

## Thresholds (MiniLM)

| Pair type | Cosine range |
|---|---|
| Same fact, reworded | 0.93 – 0.99 |
| Same subject, updated detail ("Q1" → "Q2", "16 kHz" → "48 kHz") | 0.47 – 0.96 |
| Same subject, different fact | 0.25 – 0.51 |
| Unrelated | −0.01 – 0.13 |

Updated facts overlap with true duplicates: embeddings barely register a changed number or name. So a duplicate must also match on **salient tokens** (numbers, dates, names, other capitalised terms). Without that check, "launch moved to Q2" would be silently discarded as a duplicate of "launch is Q1".

Resulting profile: `dup 0.92` (and salient tokens match), `related 0.55` (flag as possibly superseding), `conflict 0.80` (high similarity but different details → reported by `maintain` as a possible contradiction), `strong 0.40` (confident routing), `floor 0.25` (weakest semantic hit returned).

Profiles for every supported model live in `src/embed.js`. Voyage uses an uncalibrated default; PRs with measurements welcome.

## EmbeddingGemma-300M (opt-in)

Same pair method, `onnx-community/embeddinggemma-300m-ONNX` at q4, with the prompts it was trained with (`task: search result | query: ` for questions, `title: none | text: ` for notes). Its scores sit in a higher band than MiniLM's, so the thresholds move up:

| Pair type | MiniLM | EmbeddingGemma |
|---|---|---|
| Same fact, reworded | 0.93 – 0.99 | 0.88 – 0.99 |
| Same subject, updated detail | 0.47 – 0.96 | 0.76 – 0.96 |
| Same subject, different fact | 0.25 – 0.51 | 0.46 – 0.66 |
| Unrelated | −0.01 – 0.13 | 0.19 – 0.34 |

Profile: `dup 0.87`, `related 0.70`, `conflict 0.85`, `strong 0.52`, `floor 0.20` (`src/embed.js`). The floor is deliberately **not** above the unrelated maximum: a Spanish question about an English note scores 0.25 to 0.5, and floors of 0.30 and 0.40 cut Spanish hit@5 on [`eval/paraphrase.js`](../eval/paraphrase.js) from 97.5% to 87.4% and 77.3%. The floor filters little in any case: for 20 off-topic questions against a 119-note vault, recall returned about 6 notes on average with MiniLM at its floor of 0.25 and with EmbeddingGemma at 0.20 to 0.40 alike (the rest come from word matches and graph neighbours), so a real relevance cut-off would be a separate change.

The pairs are few (6 duplicate, 6 updated, 4 same-topic, 5 unrelated), so the margins are narrow for the duplicate threshold (lowest duplicate 0.88, `dup` 0.87). On the in-repo duplicate / update / new set it classifies 72.7% of 11 against MiniLM's 81.8%; both miss the same two duplicates, and the extra miss is a new fact flagged as a possible update (it is saved with a hint, never dropped).
