# Platforms

| Platform | Status | How it is checked |
|---|---|---|
| Linux | supported | CI on every push and pull request: Node 20, 22 and 24 |
| macOS | supported | CI on every push and pull request: Node 22 |
| Windows | **not supported yet** | the suite runs weekly and on demand in `windows.yml` (informational, never blocks a merge) |
| WSL | expected to behave like Linux | not tested separately |

## Windows, honestly

When CI first ran the suite on Windows (Node 22), about 19 tests failed. They fall into three groups:

- **The tests assume POSIX** (most of them). They build fake `npm` and `claude` programs as shell scripts, assert file modes (`0600`, `0700`), use `ulimit`, create a file named `bad<name.md`, expect `/nope.jsonl` in an error message, or sign commits with `ssh-keygen`. These say nothing about githippo itself, but until they are rewritten the Windows result can't be read as "works".
- **Real gaps in the product**, now partly fixed: hooks assumed `/`-separated paths (the project name, the changed-files check, the steering text). That is covered by a test that runs on every platform (`test/report6.test.js`). Still open: registering the MCP server calls `claude` without a shell, which doesn't find an npm-installed `claude.cmd`; setup then prints the one-line `claude mcp add` command instead; `install.sh` is a POSIX shell script (on Windows install with `npm i -g github:AnxovatomicaES/githippo#<tag>` and run `githippo setup`).
- **Two test files hang** (`report4-infra`, `report4-robust`: a 60 s timeout each), cause not yet found.

If you want to help: run `npm test` on Windows, pick a failing test, and say in the pull request whether it is a test assumption or a product bug. `windows.yml` can be started by hand from the Actions tab.
