// Memory-poisoning screen: refuse to store text that reads as instructions aimed at an AI. Memory is replayed
// into future sessions as trusted context, so an injected line would carry the user's authority forever.
// High-precision patterns only: a false positive blocks a legitimate fact, so ordinary text must pass.
const PATTERNS = [
  ["override", /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|system|original)\s+(instructions?|prompts?|rules|messages?|directions)/i],
  ["override", /\b(ignora|olvida)\s+(todas\s+)?(las\s+)?instrucciones\s+(anteriores|previas)/i],
  ["role", /\b(you are now|from now on,? you (are|will|must)|act as (an?|the) (unfiltered|unrestricted|jailbroken))\b/i],
  ["fake-turn", /(^|\n)\s*(system|assistant|developer)\s*:\s*\S|<\|im_start\|>|<\/?(system|instructions?)>|\[\/?INST\]|BEGIN (SYSTEM|ADMIN) (PROMPT|INSTRUCTIONS)/i],
  ["secrecy", /\b(do not|don't|never)\s+(tell|inform|mention|reveal|show)\s+(this\s+to\s+)?(the\s+)?user\b/i],
  ["exfiltration", /!\[[^\]]*\]\(https?:\/\/[^)]*[?&][^)]*=|\b(send|post|upload|forward|exfiltrate)\b[^.\n]{0,60}\b(api[_ ]?keys?|tokens?|passwords?|credentials|secrets?|memory|conversation)\b[^.\n]{0,40}\b(to|at)\s+(https?:\/\/|[\w.-]+@)/i],
  ["tool-hijack", /\b(call|invoke|use|run)\s+the\s+[\w-]+\s+tool\s+(to|and)\s+(delete|forget|send|write|remember)/i],
];

/**
 * For text copied out of a session (tool output, web pages, errors): if it reads as instructions to an AI, it is
 * replaced by a marker, so a saved checkpoint can't replay an attack into the next session.
 */
export const defang = (text) => (injectionKinds(text).length ? "[instruction-like text removed]" : text);

/** Returns the kinds of injection found (empty = looks like an ordinary fact). */
export function injectionKinds(text) {
  const s = String(text || "");
  return [...new Set(PATTERNS.filter(([, re]) => re.test(s)).map(([k]) => k))];
}
