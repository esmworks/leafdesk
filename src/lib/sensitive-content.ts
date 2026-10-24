/**
 * Sensitive content detection (server/sensitive-content.ts scans saved pages and rows with it):
 * payment card numbers, IBANs, Turkish national ID numbers and secrets (private keys and well-known
 * token shapes). Pure, for the server and the settings tab alike.
 *
 * Each detector errs on the side of missing something rather than crying wolf: a card number needs
 * a known issuer prefix, a length that issuer uses and a Luhn check digit; an IBAN its country's
 * length and the mod-97 check; a national ID number both of its check digits; a token a shape only
 * that service's tokens have. A value found never leaves this module whole: callers get a masked
 * form to show and a fingerprint (a keyed hash the caller supplies) to know it again.
 */

export const SENSITIVE_KINDS = ["card", "iban", "national_id", "private_key", "aws_key", "github_token", "slack_token", "api_key", "jwt"] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

export const isSensitiveKind = (value: unknown): value is SensitiveKind =>
  typeof value === "string" && (SENSITIVE_KINDS as readonly string[]).includes(value);

/** Open until the page no longer holds it (resolved) or an owner dismisses it. */
export const SENSITIVE_STATUSES = ["open", "resolved", "dismissed"] as const;
export type SensitiveStatus = (typeof SENSITIVE_STATUSES)[number];

/** How much of a page (title, body and values together) is read; the rest isn't scanned. */
export const MAX_SCAN_CHARS = 200_000;
/** Findings one page can have at once; past it, the rest of the page isn't reported. */
export const MAX_FINDINGS_PER_PAGE = 50;

export type SensitiveMatch = {
  kind: SensitiveKind;
  /**
   * What the settings and the audit log show: `**** **** **** 4242`, `TR** **** **** 1326`,
   * `ghp_…3f9a`, `BEGIN RSA PRIVATE KEY` (without the dashes, which would read as a key block).
   */
  masked: string;
  /** The caller's keyed hash of the value, to know it again in a later scan. */
  fingerprint: string;
};

/** Makes the fingerprint of a value found (the server's keyed hash); the value goes no further. */
export type Fingerprint = (kind: SensitiveKind, value: string) => string;

// ------------------------------------------------------------------------------------- checks

/** The Luhn check digit of a card number (digits only) is right. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** Issuer prefixes and the lengths their cards have. */
const CARD_ISSUERS: { prefix: (n: number, digits: string) => boolean; lengths: number[] }[] = [
  // Visa.
  { prefix: (_n, d) => d.startsWith("4"), lengths: [13, 16, 19] },
  // Mastercard: 51–55 and 2221–2720.
  { prefix: (_n, d) => inRange(d, 2, 51, 55) || inRange(d, 4, 2221, 2720), lengths: [16] },
  // American Express.
  { prefix: (_n, d) => d.startsWith("34") || d.startsWith("37"), lengths: [15] },
  // Discover: 6011, 644–649, 65.
  { prefix: (_n, d) => d.startsWith("6011") || inRange(d, 3, 644, 649) || d.startsWith("65"), lengths: [16, 17, 18, 19] },
  // JCB: 3528–3589.
  { prefix: (_n, d) => inRange(d, 4, 3528, 3589), lengths: [16, 17, 18, 19] },
  // Diners Club: 300–305, 36, 38, 39.
  { prefix: (_n, d) => inRange(d, 3, 300, 305) || d.startsWith("36") || d.startsWith("38") || d.startsWith("39"), lengths: [14, 15, 16, 17, 18, 19] },
  // UnionPay.
  { prefix: (_n, d) => d.startsWith("62"), lengths: [16, 17, 18, 19] },
  // Troy.
  { prefix: (_n, d) => d.startsWith("9792"), lengths: [16] },
];

function inRange(digits: string, size: number, low: number, high: number) {
  const n = Number(digits.slice(0, size));
  return digits.length >= size && n >= low && n <= high;
}

/** Whether digits (no separators) make a card number: a known issuer's prefix and length, and Luhn. */
export function isCardNumber(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  // One digit over and over (test patterns, placeholders) is no card.
  if (/^(\d)\1+$/.test(digits)) return false;
  const n = digits.length;
  return CARD_ISSUERS.some((issuer) => issuer.lengths.includes(n) && issuer.prefix(n, digits)) && luhnValid(digits);
}

/** The length of each country's IBAN (the IBAN registry). */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32, LI: 21, LT: 20, LU: 20,
  LV: 21, LY: 25, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28, TL: 23, TN: 24, TR: 26,
  UA: 29, VA: 22, VG: 24, XK: 20,
};

/** Whether a compact IBAN (no spaces, upper case) has its country's length and passes mod 97. */
export function isIban(compact: string): boolean {
  const length = IBAN_LENGTHS[compact.slice(0, 2)];
  if (!length || compact.length !== length || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const value = char >= "A" ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Whether 11 digits make a Turkish national ID number (T.C. kimlik no): not starting with 0, both check digits right. */
export function isTurkishNationalId(digits: string): boolean {
  if (!/^[1-9]\d{10}$/.test(digits)) return false;
  const d = [...digits].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8];
  const even = d[1] + d[3] + d[5] + d[7];
  const tenth = (((odd * 7 - even) % 10) + 10) % 10;
  const eleventh = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d[9] === tenth && d[10] === eleventh;
}

// ------------------------------------------------------------------------------------ masking

export const maskCard = (digits: string) => `**** **** **** ${digits.slice(-4)}`;
export const maskIban = (compact: string) => `${compact.slice(0, 2)}** **** **** ${compact.slice(-4)}`;
export const maskNationalId = (digits: string) => `${"*".repeat(9)}${digits.slice(-2)}`;
/** A token: the prefix that says what it is and its last four characters, to tell which one to replace. */
export const maskToken = (prefix: string, token: string) => `${prefix}…${token.slice(-4)}`;

// ------------------------------------------------------------------------------------ finding

type Found = { kind: SensitiveKind; value: string; masked: string; start: number; end: number };

const PRIVATE_KEY = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY(?: BLOCK)?-----([\s\S]{0,8000}?)(?:-----END |$)/g;

/** Groups of digits with at most one space or dash between them, not inside a longer run of letters or digits. */
const DIGIT_RUN = /(?<![0-9A-Za-z])\d(?:[ -]?\d){10,40}(?![0-9A-Za-z])/g;

/** A country code, two check digits and the rest, written compact or in groups. */
const IBAN_CANDIDATE = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){10,30}/g;

/**
 * Token shapes: only what a service's own tokens look like. `prefix` is what the masked form
 * keeps. `check`: more a match must meet to count.
 */
const TOKENS: { kind: SensitiveKind; pattern: RegExp; prefix: (match: string) => string; check?: (match: string) => boolean }[] = [
  { kind: "aws_key", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g, prefix: (m) => m.slice(0, 4) },
  { kind: "github_token", pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,251}(?![A-Za-z0-9_])/g, prefix: (m) => m.slice(0, 4) },
  { kind: "github_token", pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{60,255}(?![A-Za-z0-9_])/g, prefix: () => "github_pat_" },
  { kind: "slack_token", pattern: /(?<![A-Za-z0-9-])xox[abpors]-\d{6,}-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g, prefix: (m) => m.slice(0, 5) },
  {
    kind: "api_key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-|ant-(?:api\d\d-)?)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
    prefix: (m) => m.match(/^sk-(?:proj-|svcacct-|admin-|ant-(?:api\d\d-)?)?/)![0],
    // Random keys mix cases and digits; a long kebab-case name ("sk-some-long-identifier-…") doesn't.
    check: (m) => /[0-9]/.test(m.slice(3)) && /[A-Z]/.test(m.slice(3)) && /[a-z]/.test(m.slice(3)),
  },
  { kind: "api_key", pattern: /(?<![A-Za-z0-9_])[rs]k_live_[A-Za-z0-9]{20,}(?![A-Za-z0-9_])/g, prefix: (m) => m.slice(0, 8) },
  { kind: "api_key", pattern: /(?<![A-Za-z0-9_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, prefix: () => "AIza" },
  // Leafdesk's own REST API tokens (server/api/tokens.ts).
  { kind: "api_key", pattern: /(?<![A-Za-z0-9_])esi_[A-Za-z0-9]{40}(?![A-Za-z0-9_])/g, prefix: () => "esi_" },
  {
    kind: "jwt",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    prefix: () => "eyJ",
    // The header must be JSON naming an algorithm.
    check: (m) => {
      try {
        const part = m.slice(0, m.indexOf(".")).replace(/-/g, "+").replace(/_/g, "/");
        const header = JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="))) as unknown;
        return typeof header === "object" && header !== null && "alg" in header;
      } catch {
        return false;
      }
    },
  },
];

/** Blanks the parts of `text` already found, so other detectors don't read them again. */
function blank(text: string, found: Found[]) {
  if (!found.length) return text;
  let out = "";
  let at = 0;
  for (const { start, end } of [...found].sort((a, b) => a.start - b.start)) {
    if (start < at) continue;
    out += text.slice(at, start) + " ".repeat(end - start);
    at = end;
  }
  return out + text.slice(at);
}

function privateKeys(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(PRIVATE_KEY)) {
    const body = match[2].replace(/\s+/g, "");
    // A header with nothing after it is an example, not a key.
    if (body.length < 64) continue;
    found.push({ kind: "private_key", value: body, masked: `BEGIN ${match[1]}PRIVATE KEY`, start: match.index, end: match.index + match[0].length });
  }
  return found;
}

function ibans(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(IBAN_CANDIDATE)) {
    const length = IBAN_LENGTHS[match[0].slice(0, 2)];
    if (!length) continue;
    // The candidate can run on into what follows; it is the IBAN only if its length ends where a group does.
    let count = 0;
    let end = 0;
    for (; end < match[0].length && count < length; end++) if (match[0][end] !== " ") count++;
    if (count < length || (end < match[0].length && match[0][end] !== " ")) continue;
    const compact = match[0].slice(0, end).replace(/ /g, "");
    if (!isIban(compact)) continue;
    found.push({ kind: "iban", value: compact, masked: maskIban(compact), start: match.index, end: match.index + end });
  }
  return found;
}

function digitRuns(text: string): Found[] {
  const found: Found[] = [];
  for (const match of text.matchAll(DIGIT_RUN)) {
    const run = match[0];
    const separators = new Set(run.match(/[ -]/g) ?? []);
    // "1234 5678-9012 3456" is no one number.
    if (separators.size > 1) continue;
    if (!separators.size) {
      if (isCardNumber(run)) found.push({ kind: "card", value: run, masked: maskCard(run), start: match.index, end: match.index + run.length });
      else if (isTurkishNationalId(run)) found.push({ kind: "national_id", value: run, masked: maskNationalId(run), start: match.index, end: match.index + run.length });
      continue;
    }
    // Written in groups, a card number can be followed by more groups ("4242 4242 4242 4242 12 26"
    // for its expiry): the longest run of whole groups from the start that makes one.
    const groups = run.split(/[ -]/);
    for (let count = groups.length; count > 0; count--) {
      const digits = groups.slice(0, count).join("");
      if (digits.length < 13) break;
      if (digits.length > 19 || !isCardNumber(digits)) continue;
      const length = groups.slice(0, count).join(" ").length;
      found.push({ kind: "card", value: digits, masked: maskCard(digits), start: match.index, end: match.index + length });
      break;
    }
  }
  return found;
}

function tokens(text: string): Found[] {
  const found: Found[] = [];
  for (const { kind, pattern, prefix, check } of TOKENS) {
    for (const match of text.matchAll(pattern)) {
      if (check && !check(match[0])) continue;
      found.push({ kind, value: match[0], masked: maskToken(prefix(match[0]), match[0]), start: match.index, end: match.index + match[0].length });
    }
  }
  return found;
}

/**
 * The sensitive values in `text` (read up to MAX_SCAN_CHARS), each kind and value once, at most
 * `limit` of them: kinds, masked forms and fingerprints only.
 */
export function findSensitive(text: string, fingerprint: Fingerprint, limit = MAX_FINDINGS_PER_PAGE): SensitiveMatch[] {
  let rest = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const found: Found[] = [];
  // Keys and IBANs first: their digits mustn't be read as card or ID numbers.
  for (const detect of [privateKeys, ibans, digitRuns, tokens]) {
    const more = detect(rest);
    found.push(...more);
    rest = blank(rest, more);
  }
  const out = new Map<string, SensitiveMatch>();
  for (const f of found.sort((a, b) => a.start - b.start)) {
    if (out.size >= limit) break;
    const print = fingerprint(f.kind, f.value);
    const key = `${f.kind}:${print}`;
    if (!out.has(key)) out.set(key, { kind: f.kind, masked: f.masked, fingerprint: print });
  }
  return [...out.values()];
}

/** The text of a row's values: every string in them (text, URLs, emails, phone numbers…), one per line. */
export function valueText(values: unknown, max = MAX_SCAN_CHARS): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (value: unknown, depth: number) => {
    if (size >= max || depth > 8) return;
    if (typeof value === "string") {
      parts.push(value);
      size += value.length + 1;
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  walk(values, 0);
  return parts.join("\n");
}
