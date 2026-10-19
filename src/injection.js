// Memory-poisoning screen: refuse to store text that reads as instructions aimed at an AI. Memory is replayed
// into future sessions as trusted context, so an injected line would carry the user's authority forever.
// High-precision patterns only: a false positive blocks a legitimate fact, so ordinary text must pass.
import { normalizeForScan } from "./guard.js";
import { plain } from "./parse.js";

// Every quantifier here is bounded or anchored: this runs on text that arrives from outside, and an unbounded `\s*` or `[^]]*`
// tried at every position made 65,000 newlines (or "![" repeated) take seconds.
const PATTERNS = [
  ["override", /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|system|original)\s+(instructions?|prompts?|rules|messages?|directions)/i],
  ["override", /\b(ignora|olvida)\s+(todas\s+)?(las\s+)?instrucciones\s+(anteriores|previas)/i],
  ["role", /\b(you are now|from now on,? you (are|will|must)|act as (an?|the) (unfiltered|unrestricted|jailbroken))\b/i],
  // "system:"/"developer:" lines, chat-template tokens, or an assistant/human/user label followed by an instruction: a plain
  // "Assistant: Laura handles John's calendar" is a fact about a person
  ["fake-turn", /(^|\n)[ \t]*(system|developer)[ \t]*:[ \t]*\S|(^|\n)[ \t]*(assistant|human|user)[ \t]*:[^\n]{0,200}\b(ignore|disregard|you must|you will|always|never|do not|don't|send|forward|reveal|override)\b|<\|im_start\|>|<\/?(system|instructions?)>|\[\/?INST\]|BEGIN (SYSTEM|ADMIN) (PROMPT|INSTRUCTIONS)/i],
  ["secrecy", /\b(do not|don't|never)\s+(tell|inform|mention|reveal|show)\s+(this\s+to\s+)?(the\s+)?user\b/i],
  ["exfiltration", /!\[[^\]]{0,200}\]\(https?:\/\/[^)?&]{0,500}[?&][^)]{0,500}=|\b(send|post|upload|forward|exfiltrate)\b[^.\n]{0,60}\b(api[_ ]?keys?|tokens?|passwords?|credentials|secrets?|memory|conversation)\b[^.\n]{0,40}\b(to|at)\s+(https?:\/\/|[\w.-]+@)/i],
  ["tool-hijack", /\b(call|invoke|use|run)\s+the\s+[\w-]+\s+tool\s+(to|and)\s+(delete|forget|send|write|remember)/i],
];

/**
 * For text copied out of a session (tool output, web pages, errors): if it reads as instructions to an AI, it is
 * replaced by a marker, so a saved checkpoint can't replay an attack into the next session.
 */
export const defang = (text) => (injectionKinds(text).length ? "[instruction-like text removed]" : text);

/**
 * Returns the kinds of injection found (empty = looks like an ordinary fact). The text is screened twice: as written, and as it
 * will be READ: recall drops HTML comments and renders [[x|word]] as "word", so "ig<!--x-->nore all previous instructions" and
 * "ig[[x|nore]] all…" became the canonical sentence only after the screen had passed them; and zero-width characters or Cyrillic
 * lookalikes ("i\u200bgnore", "іgnore") read as the same words to a model. This is a heuristic for the common phrasings, not a
 * guarantee: a paraphrase gets through.
 */
export function injectionKinds(text) {
  const raw = String(text || "");
  const asciiOnly = /^[\n\t\x20-\x7e]*$/.test(raw) && !raw.includes("<!--") && !raw.includes("[[");
  const seen = asciiOnly ? raw : normalizeForScan(plain(raw)); // plain ASCII with no comments or links reads as written
  const variants = seen === raw ? [raw] : [raw, seen];
  return [...new Set(PATTERNS.filter(([, re]) => variants.some((v) => re.test(v))).map(([k]) => k))];
}
