// Human-in-the-loop confirmation for the memory writes that matter most, using MCP elicitation (the server asks
// the user a question through the client; Claude Code declares support for it, verified in its 2.1.302 binary).
//
//   GITHIPPO_CONFIRM=auto    (default) ask when the client can show a form; otherwise proceed as before
//   GITHIPPO_CONFIRM=strict  refuse these writes unless the user confirmed (also when the client can't ask)
//   GITHIPPO_CONFIRM=off     never ask
//
// What it asks about, and why:
//   external  a fact that came from a web page, file or tool output: the poisoning channel
//   pin       pinning to core memory: injected into every future session and treated as always true
//   forget    removing a fact: shows the exact line, since Claude picked it
// Ordinary facts the user stated are never interrupted. Questions are asked BEFORE any lock is taken, so a
// slow answer never blocks other memory writes.
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";

export const confirmMode = (env = process.env) => (["off", "strict"].includes(env.GITHIPPO_CONFIRM) ? env.GITHIPPO_CONFIRM : "auto");

/** An empty `elicitation: {}` means form mode (MCP spec backwards compatibility; that's what Claude Code declares). */
export function canElicit(server) {
  const e = server.server.getClientCapabilities?.()?.elicitation;
  return !!e && (Object.keys(e).length === 0 || !!e.form);
}

const clip = (s, n = 300) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

const QUESTIONS = {
  external: ({ text }) => ({
    message: `Claude wants to save a fact that came from an EXTERNAL source (a web page, file or tool output), which could contain planted instructions:\n\n“${clip(text)}”\n\nSave it? It will be marked [external] when recalled.`,
    title: "Save this external fact to memory",
  }),
  pin: ({ text }) => ({
    message: `Claude wants to PIN this to core memory. Core memory is loaded into every future session and treated as always true:\n\n“${clip(text)}”`,
    title: "Pin to core memory",
  }),
  forget: ({ text, path }) => ({
    message: `Claude wants to REMOVE this fact from ${path}:\n\n“${clip(text)}”\n\n(git history keeps a copy.)`,
    title: "Remove this fact",
  }),
};

/** Resolves to { ok: true } to go ahead, or { ok: false, reason } to stop. */
export async function gate(server, kind, details, env = process.env) {
  const mode = confirmMode(env);
  if (mode === "off") return { ok: true };
  if (!canElicit(server)) {
    return mode === "strict"
      ? { ok: false, reason: `this needs your confirmation, but this client can't ask (GITHIPPO_CONFIRM=strict). Use a client with elicitation, or set GITHIPPO_CONFIRM=auto` }
      : { ok: true, unconfirmed: true };
  }
  const q = QUESTIONS[kind](details);
  try {
    const r = await server.server.request(
      {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: q.message,
          requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: q.title, default: false } }, required: ["approve"] },
        },
      },
      ElicitResultSchema,
      { timeout: 180_000 },
    );
    if (r.action === "accept" && r.content?.approve === true) return { ok: true, confirmed: true };
    return { ok: false, reason: r.action === "accept" ? "you chose not to" : `you ${r.action === "cancel" ? "dismissed the question" : "declined"}` };
  } catch (e) {
    // the client advertised the capability but didn't answer: never proceed on a sensitive write
    return { ok: false, reason: `no confirmation received (${String(e.message).slice(0, 60)})` };
  }
}
