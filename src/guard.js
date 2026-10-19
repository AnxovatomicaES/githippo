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
  const s = raw.replace(/[\s-]+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  const numeric = moved.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return rem === 1;
}

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
function dniValid(raw) {
  const s = raw.replace(/[\s-]+/g, "").toUpperCase();
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

// A name that says what a value IS, not a secret ("token_url", "private_key_path", "secret_id"), and values that are plainly
// not credentials: a path, a URL (credentials inside a URL are the connection_string rule's job), or a short number for a name that
// isn't a password-like one ("tokens: 128000" is a context window).
const BENIGN_NAME = /(?:^|[_.-])(?:path|url|uri|file|dir|folder|name|id|length|limit|count|size|ttl|timeout|expiry|expires|type|endpoint|header|host|salt|version)$/i;
const STRONG_NAME = /password|passwd|pwd|contraseña|secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key/i;
const PATHLIKE = /^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:\\|https?:\/\/)/i;
function realSecretAssignment(raw) {
  const i = raw.search(/[:=]/);
  if (i < 0) return true;
  const name = raw.slice(0, i).trim().replace(/["'`*_]+$/, "");
  const value = raw.slice(i + 1).trim().replace(/^["'`*]+/, "");
  if (/secretar|tokeni[sz]|passwordless/i.test(name)) return false; // "Secretary: …", "tokenizer: …"
  if (BENIGN_NAME.test(name) || PATHLIKE.test(value)) return false;
  if (!STRONG_NAME.test(name) && /^\d{1,12}$/.test(value)) return false;
  return true;
}
// "pwd: /Users/me/project" is the working directory, not a password
const notWorkingDirectory = (raw) => !(/^pwd/i.test(raw) && PATHLIKE.test(raw.slice(raw.search(/[:=|]/) + 1).trim().replace(/^["'`*]+/, "")));

// Real cards start with an issuer prefix of a known network and have that network's length; random 13-19 digit identifiers (snowflake ids,
// millisecond timestamps) pass Luhn one time in ten, so without this ~10% of them were refused as "payment_card".
const ISSUER = /^(?:4(?:\d{12}|\d{15}|\d{18})|(?:5[1-5]\d{2}|222[1-9]|22[3-9]\d|2[3-6]\d{2}|27[01]\d|2720)\d{12}|3[47]\d{13}|(?:6011|65\d{2}|64[4-9]\d)\d{12,15}|35(?:2[89]|[3-8]\d)\d{12,15}|3(?:0[0-5]|[689]\d)\d{11,16}|62\d{14,17}|(?:50|5[6-9]|6\d)\d{10,17}|220[0-4]\d{12,15}|8[12]\d{14,17}|9792\d{12})$/;

const RULES = [
  { kind: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g }, // incl. "PGP PRIVATE KEY BLOCK"
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
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g }, // short segments and an empty (alg:none) signature too
  // a value with a digit or symbol (6+), or a long all-letters passphrase (14+); "password: required" is just a sentence
  // ("db_password": "…" and **Password:** … have a quote or markdown between the word and the colon)
  { kind: "password_assignment", re: /\b(?:password|passwd|pwd|contraseña|secret)["'`*_]{0,3}[ \t]*[:=]["'`*_]{0,3}\s*(?:(?=\S{0,200}[\d!@#$%^&*()+=/\\|~`])\S{6,300}|[A-Za-z]{14,300})/gi, check: notWorkingDirectory },
  // | password | hunter2hunter2 |  (a table cell; a value must have a digit or a symbol, so a header cell like "Description" saves)
  { kind: "password_assignment", re: /\b(?:password|passwd|pwd|contraseña)[ \t]*\|[ \t]*(?=[^\s|]{0,200}[\d!@#$%^&*()+=/\\~`])[^\s|]{6,300}/gi },
  // "the VPN password is Tr0ub4dor&3"
  { kind: "password_assignment", re: /\b(?:password|passwd|passcode)[ \t]+(?:is|was)[ \t]*:?[ \t]*(?=[^\s"',;]{0,200}[\d!@#$%^&*()+=/\\|~`])[^\s"',;]{6,300}/gi },
  // env-style names (DB_PASSWORD=…, AWS_SECRET_ACCESS_KEY=…, STRIPE_API_KEY: …): the value must look secret (a digit or a symbol),
  // so a note saying "token: required" or "password: rotate" still saves
  { kind: "secret_assignment", re: /(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]{0,40}(?:password|passwd|pwd|contraseña|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]{0,40}["'`]?\s{0,3}[:=]\s{0,3}["']?(?=[^\s"',;]{6})(?=[^\s"',;]{0,200}[\d!@#$%^&*()+=/\\|~`])[^\s"',;]{1,300}/gi, check: realSecretAssignment },
  // STRIPE_KEY=…, DB_PASS=…, SLACK_AUTH=… : upper-case environment names ending in a secret-ish word
  { kind: "secret_assignment", re: /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:PASS|PASSWD|PWD|KEY|SECRET|TOKEN|AUTH|CREDS?|CREDENTIALS?)["'`]?[ \t]{0,3}[:=][ \t]{0,3}["']?(?=[^\s"',;]{6})(?=[^\s"',;]{0,200}[\d!@#$%^&*()+=/\\|~`])[^\s"',;]{1,300}/g, check: realSecretAssignment },
  // scheme://user:password@host (database and broker URLs); the user may be empty (redis://:password@host)
  { kind: "connection_string", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]*:[^\s@/]+@[^\s/]+/gi },
  // "PIN: 4821", "pin code is 123456"
  { kind: "pin_code", re: /\b(?:pin(?:[ _-]?code)?|c[oó]digo pin)[ \t]*(?:is|was|[:=])[ \t]*\d{4,8}\b/gi },
  // opaque credentials in HTTP headers, and the formats of services whose tokens have no fixed prefix
  { kind: "auth_header", re: /\bAuthorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|Token)[ \t]+[A-Za-z0-9._~+\/=-]{16,}/gi },
  { kind: "bearer_token", re: /\bBearer[ \t]+(?=[A-Za-z0-9._~+\/-]{0,200}\d)[A-Za-z0-9._~+\/-]{24,}={0,2}/g },
  { kind: "gitlab_token", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "google_oauth_token", re: /\bya29\.[A-Za-z0-9_-]{20,}/g },
  { kind: "slack_token", re: /\bxapp-[A-Za-z0-9-]{10,}/g },
  { kind: "webhook_url", re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+|https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  { kind: "discord_bot_token", re: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/g },
  { kind: "telegram_bot_token", re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { kind: "twilio_key", re: /\bSK[0-9a-f]{32}\b/g },
  { kind: "mailgun_key", re: /\bkey-[0-9a-f]{32}\b/g },
  { kind: "azure_key", re: /\bAccountKey=[A-Za-z0-9+\/]{40,}={0,2}|\bSharedAccessSignature=[^\s;]{16,}|[?&]sig=[A-Za-z0-9%+\/]{20,}={0,2}/g },
  { kind: "shopify_token", re: /\bshp(?:at|ss|ca|pa)_[a-f0-9]{32}\b/g },
  { kind: "pypi_token", re: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  { kind: "digitalocean_token", re: /\bdop_v1_[a-f0-9]{64}\b/g },
  // card security codes must never be stored, even without the card number next to them
  { kind: "card_security_code", re: /\b(?:cvv2?|cvc2?|security code|código de seguridad)\b[^\w]{0,3}\d{3,4}\b/gi },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?:[\s-]?[A-Z0-9]{4}){2,7}(?:[\s-]?[A-Z0-9]{1,4})?\b/g, check: ibanValid },
  { kind: "spanish_dni_nie", re: /\b(?:[XYZ][\s-]?\d{7}|\d{8})[\s-]?[A-Z]\b/g, check: dniValid },
  // NI numbers are written in capitals; matching them case-insensitively read "el 12/10/26 a las…" as one
  { kind: "uk_nino", re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, check: ninoValid },
  { kind: "french_nir", re: /\b[12]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}\s?\d{2}\b/gi, check: nirValid },
  { kind: "us_ssn", re: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g },
];

/**
 * What the guard actually inspects: compatibility-normalised (fullwidth digits → ASCII, NBSP → space),
 * invisible format characters removed (zero-width space/joiners, soft hyphen, BOM, bidi marks), and dots
 * between digit groups treated as separators. ID formats are matched case-insensitively via an upper-cased copy.
 */
// ID numbers can be typed in any case; API keys and tokens are case-exact formats.
const CASE_INSENSITIVE = new Set(["iban", "payment_card", "spanish_dni_nie", "french_nir", "us_ssn"]);
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
    if (ch === "\\" && (src[at] === "_" || src[at] === "*")) continue; // markdown escapes: ghp\_abc renders as ghp_abc
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
    const i = Math.max(s.lastIndexOf(" "), s.lastIndexOf("-"));
    if (i < 0) return null;
    s = s.slice(0, i);
  }
}

/**
 * Card numbers: take each run of digit groups joined by single spaces or hyphens ("ref 20241 4111 1111 1111 1111 2026"),
 * and look for a window of whole groups with 13-19 digits that passes Luhn. A single regex that grabs "19 digits"
 * and then fails the checksum misses a card that merely has other digits next to it.
 */
/** Printed card numbers are one solid run or grouped 4-4-4-4(-n), 4-6-5 (Amex), 4-6-4 (Diners): never 3-3-3 like a phone number. */
const CARD_GROUPS = /^(?:4,4,4,[1-4]|4,4,4,4(?:,[1-3])?|4,6,5|4,6,4)$/;
const cardShaped = (gs) => gs.length === 1 || CARD_GROUPS.test(gs.map((g) => g.end - g.start).join(","));

function* cardMatches(norm) {
  for (const run of norm.matchAll(/(?<![\p{L}\p{N}_])\d+(?:[ -]\d+)*(?![\p{L}\p{N}_])/gu)) {
    const s = run[0];
    const groups = [...s.matchAll(/\d+/g)].map((g) => ({ start: g.index, end: g.index + g[0].length }));
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length; j++) {
        digits += s.slice(groups[j].start, groups[j].end);
        if (digits.length > 19) break;
        if (digits.length >= 13 && cardShaped(groups.slice(i, j + 1)) && luhn(digits) && ISSUER.test(digits)) {
          yield { kind: "payment_card", start: run.index + groups[i].start, end: run.index + groups[j].end, text: s.slice(groups[i].start, groups[j].end) };
          i = j; // continue after this card
          break;
        }
      }
    }
  }
}

// A redaction marker is opaque text we wrote ourselves, never a secret. Its colon, next to the surrounding text, could read as
// "scheme://user:password@host" ("…https://[redacted:payment_card]{{x@@"), so redacted output re-triggered the guard and a
// second redaction changed it again. Blank markers out (same length, so every position still lines up).
const MARKER = /\[redacted:[a-z_0-9]+\]/g;

function* ruleMatches(rawNorm) {
  const norm = rawNorm.replace(MARKER, (m) => " ".repeat(m.length));
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
  // Redacting one thing can leave two others next to each other ("passwd```" … "=======" once a card number between them is blanked), so
  // a single pass isn't always final. Repeat until nothing is left to find: markers never match, so this ends, and redact(redact(x)) == redact(x).
  let out = String(text);
  let count = 0;
  for (let pass = 0; pass < 4; pass++) {
    const r = redactOnce(out);
    if (!r.count) break;
    out = r.text;
    count += r.count;
  }
  return { text: out, count };
}

function redactOnce(text) {
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
