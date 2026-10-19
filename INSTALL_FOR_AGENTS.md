# Installing githippo (instructions for a coding agent)

githippo is a long-term memory for Claude Code. Installing it takes one command and asks nothing.

1. Check `node -v` is 20 or newer. If not, tell the user how to install Node (macOS: `brew install node`) and stop.
2. Run: `curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/install.sh | sh`
3. Run `githippo doctor` and show the user its output. Every line should start with ✓ (it exits non-zero if a check fails). If the Claude Code plugin is already installed, setup notices it and doesn't add a second copy of the hooks.
4. Tell the user to restart Claude Code.
5. Only if the user asks for backup or sync across machines: `githippo sync --github`. It uses their existing GitHub CLI login; if `gh` isn't installed or logged in, tell them to run `brew install gh && gh auth login` themselves.

Never ask the user for a GitHub token for local use, never print or store tokens, and don't change other Claude Code settings.
