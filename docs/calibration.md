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
