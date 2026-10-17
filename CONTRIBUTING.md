# Contributing to githippo

Thanks for helping the hippo remember. 🦛

```bash
git clone https://github.com/AnxovatomicaES/githippo && cd githippo
npm ci --ignore-scripts
npm test          # all tests run offline against a fake GitHub API, no tokens needed
npm run bench     # token cost of the tool surface; PRs must not grow it without a reason
```

Ground rules:

- **Tokens are a feature.** Every tool description, schema field and response format ships on every turn of every user's conversation. Measure with `npm run bench` and say in the PR what it costs.
- **Memory is the user's.** Nothing leaves their repo and their server. No telemetry, ever.
- **Hooks must never break a session.** Every failure path exits 0 with a short timeout.
- **Tests first** for routing, dedupe and retrieval changes. Use `test/helpers.js` for a seeded vault.
- Small PRs, one idea each. Look for `good first issue` labels.
