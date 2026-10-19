// Time expressions in questions → a date window, so recall can prefer facts from that period and, for
// questions about the past, include facts that have since been superseded. English and Spanish.
// Deterministic; relative expressions resolve against `now` (the question's date).
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};
const SEASONS = { spring: [2, 4], summer: [5, 7], autumn: [8, 10], fall: [8, 10], winter: [11, 13], primavera: [2, 4], verano: [5, 7], otoño: [8, 10], invierno: [11, 13] };
const day = 86_400_000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const startOfMonth = (y, m) => Date.UTC(y, m, 1);
const endOfMonth = (y, m) => Date.UTC(y, m + 1, 1) - day;

/** Returns { from, to, past } (ISO dates) or null. `past` = the question asks about an earlier state. */
/** Never throws: an expression that can't be turned into a sensible window ("300000 years ago") is just not a time window. */
export function timeWindow(query, now = new Date()) {
  try {
    const w = timeWindowUnchecked(query, now);
    return w && w.from >= "1900-01-01" && w.to <= "2200-12-31" && w.from <= w.to ? w : null;
  } catch {
    return null;
  }
}

function timeWindowUnchecked(query, now) {
  const q = String(query).toLowerCase();
  const t = typeof now === "number" ? now : new Date(now).getTime();
  const Y = new Date(t).getUTCFullYear();
  const M = new Date(t).getUTCMonth();
  const win = (a, b) => ({ from: iso(a), to: iso(b), past: b < t - day || /\b(was|were|used to|back then|at the time|before|previously|originally|antes|entonces|era|eran|solía)\b/.test(q) });
  let m;
  if ((m = q.match(/\b(\d{4})-(\d{2})-(\d{2})\b/))) return win(Date.UTC(+m[1], +m[2] - 1, +m[3]), Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if ((m = q.match(/\b(\d{4})-(\d{2})\b/))) return win(startOfMonth(+m[1], +m[2] - 1), endOfMonth(+m[1], +m[2] - 1));
  if (/\b(yesterday|ayer)\b/.test(q)) return win(t - day, t - day);
  if (/\b(today|hoy)\b/.test(q)) return win(t, t);
  if ((m = q.match(/\b(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month|year)s?\s+ago\b/)) || (m = q.match(/\bhace\s+(\d+|un|una|dos|tres|cuatro|cinco)\s+(día|dia|semana|mes|año)/))) {
    const nums = { a: 1, one: 1, un: 1, una: 1, two: 2, dos: 2, three: 3, tres: 3, four: 4, cuatro: 4, five: 5, cinco: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const n = Number(m[1]) || nums[m[1]] || 1;
    if (!(n > 0) || n > 1000) return null;
    const unit = { day: 1, día: 1, dia: 1, week: 7, semana: 7, month: 30, mes: 30, year: 365, año: 365 }[m[2]];
    const center = t - n * unit * day;
    const slack = Math.max(1, Math.round(unit * 0.5)) * day;
    return win(center - slack, center + slack);
  }
  if (/\b(last|past) week\b|\bla semana pasada\b/.test(q)) return win(t - 14 * day, t - 1 * day);
  if (/\bthis week\b|\besta semana\b/.test(q)) return win(t - 7 * day, t);
  if (/\blast month\b|\bel mes pasado\b/.test(q)) return win(startOfMonth(Y, M - 1), endOfMonth(Y, M - 1));
  if (/\bthis month\b|\beste mes\b/.test(q)) return win(startOfMonth(Y, M), t);
  if (/\blast year\b|\bel año pasado\b/.test(q)) return win(Date.UTC(Y - 1, 0, 1), Date.UTC(Y, 0, 1) - day);
  if ((m = q.match(/\b(last|this|past)\s+(spring|summer|autumn|fall|winter)\b/)) || (m = q.match(/\b(primavera|verano|otoño|invierno)\s+(pasad[oa]|de este año)\b/))) {
    const season = SEASONS[m[2]] ? m[2] : m[1];
    const [a, b] = SEASONS[season];
    let y = Y;
    if (/last|past|pasad/.test(m[0]) && startOfMonth(Y, a) > t - 30 * day) y = Y - 1;
    return win(startOfMonth(y, a), endOfMonth(y, b));
  }
  for (const [name, idx] of Object.entries(MONTHS)) {
    const re = new RegExp(`\\b(?:in|en|during|last|since|de)?\\s*${name}\\b(?:\\s+(?:of\\s+|de\\s+)?(\\d{4}))?`);
    if (name.length <= 3 && !new RegExp(`\\b${name}\\b`).test(q)) continue;
    // "march" and "may" are also ordinary words ("march forward", "may I ask"): only a month with time context
    const ambiguous = ["march", "may"].includes(name) && !new RegExp(`\\b(in|en|since|last|during|until|by|of|de)\\s+${name}\\b|\\b${name}\\s+(\\d{1,2}(st|nd|rd|th)?\\b|\\d{4}\\b)`).test(q);
    const isWord = ["march", "may"].includes(name);
    if ((m = q.match(re)) && (isWord ? !ambiguous : name.length > 3 || /\b(in|en|last|since)\s/.test(m[0]))) {
      const y = m[1] ? +m[1] : startOfMonth(Y, idx) > t ? Y - 1 : Y;
      return win(startOfMonth(y, idx), endOfMonth(y, idx));
    }
  }
  // Q1-Q4 or an UPPERCASE T1-T4 (Spanish), standing alone: "t3.large" (an AWS instance) and "t3a" are not quarters
  if ((m = String(query).match(/(?<![\w.-])(?:(?:[Ii]n|[Ee]n el|[Dd]uring)\s+)?([Qq]|T)([1-4])(?:\s+(?:[Oo]f\s+|[Dd]e\s+)?(\d{4}))?(?!\w|\.\w)/))) {
    const qn = +m[2] - 1;
    const y = m[3] ? +m[3] : startOfMonth(Y, qn * 3) > t ? Y - 1 : Y;
    return win(startOfMonth(y, qn * 3), endOfMonth(y, qn * 3 + 2));
  }
  if ((m = q.match(/\b(?:in|en|during|durante)\s+(19\d{2}|20\d{2})\b/))) return win(Date.UTC(+m[1], 0, 1), Date.UTC(+m[1], 11, 31));
  return null;
}

/** Does any of the dates (ISO) fall inside the window? */
export const inWindow = (dates, w) => !!w && (dates || []).some((d) => d >= w.from && d <= w.to);
