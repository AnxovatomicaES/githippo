# Installing githippo (instructions for a coding agent)

You are installing githippo, a long-term memory MCP server for Claude Code. Follow these steps in order and stop to ask the user whenever a step needs something only they can provide.

1. Check prerequisites: `node -v` must be 20 or newer; `claude --version` must work.
2. Install: `npm i -g github:AnxovatomicaES/githippo#v3.1.2`
3. Ask the user for two things. Do not invent them and do not read them from any file:
   - the name of a **private** GitHub repo for memory (owner/name), and
   - a **fine-grained** GitHub token limited to that repo with *Contents: Read and write* only.
   Tell the user to type the token into the terminal prompt themselves rather than pasting it into chat.
4. Run `githippo install` and let the user answer its prompts. It writes `~/.githippo/config.json` (mode 600), adds the Claude Code hooks, a status line if none exists, and registers the MCP server.
5. Run `githippo init`, then `githippo doctor`. Every line should start with ✓. If "repo is PUBLIC" appears, stop and tell the user to make the repo private.
6. Tell the user to restart Claude Code. Optionally run `githippo demo` to show recall working.

Never print, log or commit the token. Never change any other Claude Code settings.
