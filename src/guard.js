// Compliance guard: blocks secrets and regulated identifiers before they are
// committed to git history (where deleting them later doesn't really remove them).

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  const numeric = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function dniValid(raw) {
  const s = raw.toUpperCase();
  const nie = { X: "0", Y: "1", Z: "2" };
  const num = s.replace(/^[XYZ]/, (c) => nie[c]).slice(0, -1);
  return DNI_LETTERS[Number(num) % 23] === s.slice(-1);
}

// UK National Insurance number: two prefix letters (some never issued), six digits, suffix A-D.
function ninoValid(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  return !/^(BG|GB|KN|NK|NT|TN|ZZ)/.test(s) && /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/.test(s);
}

// French NIR (numéro de sécurité sociale): 13 digits + 2-digit key = 97 - (number mod 97). Corsica 2A/2B.
function nirValid(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  const m = s.match(/^([12]\d{4}(?:\d{2}|2A|2B)\d{6})(\d{2})$/);
  if (!m) return false;
  const n = BigInt(m[1].replace("2A", "19").replace("2B", "18"));
  return Number(97n - (n % 97n)) === Number(m[2]);
}

const RULES = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { kind: "aws_access_key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "stripe_key", re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}|\bwhsec_[A-Za-z0-9]{24,}/g },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { kind: "sendgrid_key", re: /\bSG\.[\w-]{16,32}\.[\w-]{30,50}/g },
  { kind: "npm_token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "huggingface_token", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: "password_assignment", re: /\b(?:password|passwd|pwd|contraseña|secret)\s*[:=]\s*\S{6,}/gi },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, check: ibanValid },
  { kind: "spanish_dni_nie", re: /\b[XYZ]?\d{7,8}[A-Z]\b/g, check: dniValid },
  { kind: "uk_nino", re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, check: ninoValid },
  { kind: "french_nir", re: /\b[12]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}\s?\d{2}\b/gi, check: nirValid },
  { kind: "us_ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
];

/**
 * What the guard actually inspects: compatibility-normalised (fullwidth digits → ASCII, NBSP → space),
 * invisible format characters removed (zero-width space/joiners, soft hyphen, BOM, bidi marks), and dots
 * between digit groups treated as separators. ID formats are matched case-insensitively via an upper-cased copy.
 */
// ID numbers can be typed in any case; API keys and tokens are case-exact formats.
const CASE_INSENSITIVE = new Set(["iban", "payment_card", "spanish_dni_nie", "uk_nino", "french_nir", "us_ssn"]);
const COMPILED = RULES.map((r) => ({ ...r, re: CASE_INSENSITIVE.has(r.kind) && !r.re.flags.includes("i") ? new RegExp(r.re.source, `${r.re.flags}i`) : r.re }));

// Letters that look like Latin ones (Cyrillic, Greek): "ЕS91 …" must still read as an IBAN. Scanning only.
const CONFUSABLES = Object.fromEntries(
  [..."АA ВB ЕE КK МM НH ОO РP СC ТT ХX аa еe оo рp сc уy хx іi јj ѕs ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX οo νv ιi".split(" ")].map(([a, b]) => [a, b]),
);
const SEP = /[\s._/\u2010-\u2015\u2212]/;

/** Digit value of any Unicode decimal digit (Arabic-Indic, Devanagari, math bold…): digits come in runs of ten. */
function digitValue(ch) {
  const cp = ch.codePointAt(0);
  let start = cp;
  while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

/**
 * The text as the guard reads it: compatibility-normalised, invisible and combining characters dropped, any
 * script's digits turned into 0-9, lookalike letters folded to Latin, and separators between digits (space,
 * newline, dot, underscore, slash, any dash) collapsed to one space. `spans[i]` is the [start, end) of the
 * ORIGINAL text that produced normalised character i, so a match can be replaced without touching anything else.
 */
export function normalizeWithMap(text) {
  const src = String(text);
  const out = [];
  const spans = [];
  let at = 0;
  for (const ch of src) {
    const start = at;
    at += ch.length;
    if (/[\p{Cf}\p{M}\u00ad]/u.test(ch)) continue;
    for (let c of ch.normalize("NFKC")) {
      if (/\p{Nd}/u.test(c) && !/[0-9]/.test(c)) c = String(digitValue(c));
      c = CONFUSABLES[c] || c;
      for (let u = 0; u < c.length; u++) {
        out.push(c[u]);
        spans.push([start, at]);
      }
    }
  }
  const norm = [];
  const nspans = [];
  for (let k = 0; k < out.length; k++) {
    if (SEP.test(out[k]) && norm.length && /[0-9]/.test(norm.at(-1))) {
      let e = k;
      while (e + 1 < out.length && e - k < 2 && SEP.test(out[e + 1])) e++;
      if (e + 1 < out.length && /[0-9]/.test(out[e + 1])) {
        norm.push(" ");
        nspans.push([spans[k][0], spans[e][1]]);
        k = e;
        continue;
      }
    }
    norm.push(out[k]);
    nspans.push(spans[k]);
  }
  return { norm: norm.join(""), spans: nspans };
}

export const normalizeForScan = (text) => normalizeWithMap(text).norm;

/** A pattern with an optional tail can swallow the next word ("… 1332 please"); drop trailing groups until it validates. */
function longestValid(text, check) {
  for (let s = text; ; ) {
    if (check(s)) return s;
    const i = s.lastIndexOf(" ");
    if (i < 0) return null;
    s = s.slice(0, i);
  }
}

/**
 * Card numbers: take each run of digit groups joined by single spaces or hyphens ("ref 20241 4111 1111 1111 1111 2026"),
 * and look for a window of whole groups with 13-19 digits that passes Luhn. A single regex that grabs "19 digits"
 * and then fails the checksum misses a card that merely has other digits next to it.
 */
function* cardMatches(norm) {
  for (const run of norm.matchAll(/(?<![\p{L}\p{N}_])\d+(?:[ -]\d+)*(?![\p{L}\p{N}_])/gu)) {
    const s = run[0];
    const groups = [...s.matchAll(/\d+/g)].map((g) => ({ start: g.index, end: g.index + g[0].length }));
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        digits += s.slice(groups[j].start, groups[j].end);
        if (digits.length > 19) break;
        if (digits.length >= 13 && luhn(digits)) {
          yield { kind: "payment_card", start: run.index + groups[i].start, end: run.index + groups[j].end, text: s.slice(groups[i].start, groups[j].end) };
          i = j; // continue after this card
          break;
        }
      }
    }
  }
}

function* ruleMatches(norm) {
  yield* cardMatches(norm);
  for (const { kind, re, check } of COMPILED) {
    const rx = new RegExp(re.source, re.flags); // own lastIndex
    let m;
    while ((m = rx.exec(norm))) {
      if (m[0] === "") {
        rx.lastIndex++;
        continue;
      }
      const text = !check ? m[0] : kind === "iban" ? longestValid(m[0], check) : check(m[0]) ? m[0] : null;
      if (text) {
        yield { kind, start: m.index, end: m.index + text.length, text };
        rx.lastIndex = m.index + text.length; // resume right after what was accepted (a trimmed match must not swallow what follows)
      } else rx.lastIndex = m.index + 1; // a failed check must not hide a valid match that starts inside this one
    }
  }
}
/** Returns findings; an empty array means the text is safe to store. */
export function scan(text) {
  return [...ruleMatches(normalizeWithMap(text).norm)].map(({ kind, text: v }) => ({ kind, preview: `${v.slice(0, 4)}…${v.slice(-2)}` }));
}

/**
 * Automatic captures (checkpoints from hooks) redact instead of refusing, so one pasted key doesn't cost the whole
 * checkpoint. Only the characters that formed a match are replaced; the rest of the text is returned exactly as it
 * was (the previous version returned the normalised copy: "4.1.1" became "4 1 1", accents and emoji changed).
 */
export function redact(text) {
  const src = String(text);
  const { norm, spans } = normalizeWithMap(src);
  const found = [...ruleMatches(norm)].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let pos = 0;
  let count = 0;
  let lastEnd = -1;
  for (const f of found) {
    if (f.start < lastEnd) continue; // overlaps a match we already took
    const s = spans[f.start][0];
    const e = spans[f.end - 1][1];
    if (s < pos) continue;
    out += src.slice(pos, s) + `[redacted:${f.kind}]`;
    pos = e;
    lastEnd = f.end;
    count++;
  }
  return { text: out + src.slice(pos), count };
}
