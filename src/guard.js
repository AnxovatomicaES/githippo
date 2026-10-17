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
  { kind: "payment_card", re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => luhn(m.replace(/\D/g, "")) && m.replace(/\D/g, "").length >= 13 },
  { kind: "spanish_dni_nie", re: /\b[XYZ]?\d{7,8}[A-Z]\b/g, check: dniValid },
  { kind: "uk_nino", re: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g, check: ninoValid },
  { kind: "french_nir", re: /\b[12]\s?\d{2}\s?\d{2}\s?(?:\d{2}|2A|2B)\s?\d{3}\s?\d{3}\s?\d{2}\b/gi, check: nirValid },
  { kind: "us_ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
];

/** Returns findings; an empty array means the text is safe to store. */
export function scan(text) {
  const findings = [];
  for (const { kind, re, check } of RULES) {
    for (const m of text.matchAll(re)) {
      if (check && !check(m[0])) continue;
      const v = m[0];
      findings.push({ kind, preview: `${v.slice(0, 4)}…${v.slice(-2)}` });
    }
  }
  return findings;
}

/**
 * B24: automatic captures (checkpoints from hooks) redact instead of refusing, so one pasted key doesn't
 * cost the whole checkpoint. Explicit saves (remember) still refuse, so nothing is silently altered.
 */
export function redact(text) {
  let out = text;
  let count = 0;
  for (const { kind, re, check } of RULES) {
    out = out.replace(re, (m) => {
      if (check && !check(m)) return m;
      count++;
      return `[redacted:${kind}]`;
    });
  }
  return { text: out, count };
}
