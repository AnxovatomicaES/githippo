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

Things that will trip you up (all learned the hard way):

- **No secret-shaped literals in the source.** GitHub's push protection rejects a push that contains something that looks like a Slack webhook, a Twilio key and so on, even in a test. Build fake credentials at run time (`["S", "K", "0123…"].join("")`, see `test/report5-content.test.js`).
- **Timing assertions use `speedFactor()`** from `test/helpers.js` and a generous limit: CI runners are slower and noisier than a laptop. Assert on counts and bytes where you can, and on time only to catch a blow-up (an accidentally quadratic regex), never to measure.
- **Tests that touch hooks or `~/.githippo` set `GITHIPPO_HOME` before importing anything** (`HOME_DIR` is read once, at import) and use a temp folder. Never run `githippo setup`, `install` or `uninstall` against your real home: use `HOME=<tmp>` and a fake `claude` on `PATH`.
- **Anything that reads text from outside (a note, a transcript, a prompt) must be linear.** An unbounded `\s*` or `[^]]*` tried at every position is the usual culprit; `npm run fuzz` checks for it, and `test/report5-content.test.js` has the shapes that have bitten before.
- **A fix gets a test that fails without it.** Run the new test against the commit before your change (`git worktree add --detach /tmp/before <sha>`) to be sure it isn't passing for the wrong reason.

