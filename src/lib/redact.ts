/**
 * Masks credentials in what Leafdesk keeps or logs about work done outside it: an agent's steps,
 * answer and errors, the input of a call waiting for approval, a connection's events and errors,
 * an automation's step errors, the audit log and the server's log. The secret part becomes
 * `[redacted]`; what is around it stays, so the record still says what happened ("Bearer
 * [redacted]", "ghp_[redacted]", "https://deploy:[redacted]@host", "?api_key=[redacted]").
 *
 * It looks for credentials by where they sit (a URL's password, a credential-named query or
 * object key, an Authorization header) and by the shapes of well-known tokens, never by "long and
 * random": ids (UUIDs) and ordinary words go through. Masking twice gives the same as once.
 * Applied where text is kept or logged, never where a call is made: what is sent is the original.
 */

export const REDACTED = "[redacted]";

/** How deep, and how many values, redactValue goes before masking whatever is left whole. */
const MAX_DEPTH = 32;
const MAX_NODES = 50_000;

// ------------------------------------------------------------------------------------- names

/** Object keys (lowercase, without `-` and `_`) whose values are credentials. */
const CREDENTIAL_KEYS = new Set([
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "apikey",
  "xapikey",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "privatekey",
  "secretkey",
  "secretaccesskey",
]);

/** Endings that make a key a credential too (`githubToken`, `db_password`, `openai_api_key`). */
const CREDENTIAL_KEY_ENDINGS = ["token", "secret", "password", "passwd", "apikey", "privatekey", "secretkey"];

/** Whether an object key names a credential. Exact after folding, so `tokenChanged` or `inputTokens` don't. */
export function isCredentialKey(key: string) {
  const folded = key.toLowerCase().replace(/[-_]/g, "");
  if (!folded) return false;
  return CREDENTIAL_KEYS.has(folded) || CREDENTIAL_KEY_ENDINGS.some((end) => folded.endsWith(end));
}

/**
 * Names that are credentials only as a URL's query or fragment parameter: `code` (an OAuth code),
 * `key`, `sig`… are ordinary words elsewhere.
 */
const QUERY_ONLY_NAMES = new Set([
  "code",
  "key",
  "sig",
  "signature",
  "auth",
  "apikey",
  "xapikey",
  "pwd",
  "xamzsignature",
  "xamzcredential",
  "xamzsecuritytoken",
  "xgoogsignature",
  "xgoogcredential",
]);

const nameIsCredential = (name: string, inQuery: boolean) => {
  if (isCredentialKey(name)) return true;
  return inQuery && QUERY_ONLY_NAMES.has(name.toLowerCase().replace(/[-_]/g, ""));
};

// ------------------------------------------------------------------------------------ shapes

/**
 * Well-known token shapes; the prefix is kept, to tell which kind of token it was. `hint`: text
 * a match always contains, so the pattern only runs over text that has it.
 */
const TOKEN_SHAPES: { pattern: RegExp; keep: number | ((match: string) => string); hint?: string }[] = [
  // Leafdesk's own: API tokens, SCIM tokens, calendar feeds, signing secrets.
  { pattern: /\besi_[A-Za-z0-9]{16,}/g, keep: 4 },
  { pattern: /\bscim_[A-Za-z0-9]{16,}/g, keep: 5 },
  { pattern: /\bldcal_[A-Za-z0-9]{16,}/g, keep: 6 },
  { pattern: /\bwhsec_[A-Za-z0-9_-]{16,}/g, keep: 6 },
  // GitHub, GitLab, npm.
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, keep: 4 },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, keep: 11 },
  { pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g, keep: 6 },
  { pattern: /\bnpm_[A-Za-z0-9]{30,}/g, keep: 4 },
  // Slack.
  { pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{8,}/g, keep: 5 },
  { pattern: /\bxapp-[A-Za-z0-9-]{8,}/g, keep: 5 },
  // AI providers' keys (Anthropic's before the general `sk-`, so it keeps its own prefix).
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, keep: 7 },
  { pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, keep: (m) => m.match(/^sk-(?:proj-|svcacct-|admin-)?/)![0] },
  // Stripe.
  { pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g, keep: 8 },
  // AWS access key ids, Google API keys.
  { pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, keep: 4 },
  { pattern: /\bAIza[A-Za-z0-9_-]{35}/g, keep: 4 },
  // JSON Web Tokens: three base64url parts, the first a JSON object. Starting only where a run of
  // base64url characters starts (not after each `-` in it) keeps long runs from being read over
  // and over.
  { pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, keep: 0, hint: "eyJ" },
];

const PEM = /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/g;

/** `Authorization: …` and `Proxy-Authorization: …`, as a header, a JSON pair or `key=value`. */
const AUTH_HEADER = /\b((?:proxy-)?authorization)(["']?[ \t]*[:=][ \t]*["']?)(?:(bearer|basic|token|digest|bot|negotiate|ntlm|apikey)[ \t]+)?([^\s"',;]+)/gi;

/** A JSON string pair, its key checked by isCredentialKey. */
const JSON_PAIR = /"([A-Za-z0-9_-]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/** The password in a URL's user info (`scheme://user:password@host`); schemes of up to 32 characters. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s:/?#@"'<>\\`]*):([^\s/?#@"'<>\\`]+)@/gi;

/** `name=value`: in a query or fragment (after `?`, `&`, `#` or `;`), or on its own. */
const PARAM = /(^|[^A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9_.-]{0,63})=([^\s&#"'<>\\`,;)]+)/g;

/** A scheme word and a token after it, outside a header (`Bearer abc…` in an error message). */
const SCHEME_TOKEN = /\b(bearer|basic)[ \t]+([A-Za-z0-9\-._~+/]{8,}=*)/gi;

/**
 * Whether a word after "Bearer"/"Basic" is a token rather than prose: a digit or a symbol, or a
 * capital inside a word too long for a name ("basic JavaScript" is prose).
 */
const looksLikeToken = (word: string) => /[0-9+/=_.~]/.test(word) || (word.length >= 12 && /[A-Z]/.test(word.slice(1)));

// -------------------------------------------------------------------------------------- text

/** Masks the credentials in a piece of text. */
export function redactText(text: string): string {
  if (!text) return text;
  let out = text.replace(PEM, (_match, kind: string) => `-----BEGIN ${kind}PRIVATE KEY-----${REDACTED}-----END ${kind}PRIVATE KEY-----`);
  for (const { pattern, keep, hint } of TOKEN_SHAPES) {
    if (hint && !out.includes(hint)) continue;
    out = out.replace(pattern, (match) => `${typeof keep === "number" ? match.slice(0, keep) : keep(match)}${REDACTED}`);
  }
  out = out.replace(AUTH_HEADER, (_match, name: string, sep: string, scheme: string | undefined) => `${name}${sep}${scheme ? `${scheme} ` : ""}${REDACTED}`);
  out = out.replace(JSON_PAIR, (match, key: string, sep: string, value: string) => (value && isCredentialKey(key) ? `"${key}"${sep}"${REDACTED}"` : match));
  if (out.includes("://")) out = out.replace(URL_PASSWORD, (_match, scheme: string, userName: string) => `${scheme}${userName}:${REDACTED}@`);
  out = out.replace(PARAM, (match, before: string, name: string) => {
    const inQuery = before === "?" || before === "&" || before === "#" || before === ";";
    return nameIsCredential(name, inQuery) ? `${before}${name}=${REDACTED}` : match;
  });
  out = out.replace(SCHEME_TOKEN, (match, scheme: string, token: string) => (looksLikeToken(token) ? `${scheme} ${REDACTED}` : match));
  return out;
}

// ------------------------------------------------------------------------------------ values

/**
 * Masks the credentials in a JSON-like value: every string as text, and the whole value of a
 * credential-named key (`password`, `api_key`, `githubToken`…). Arrays and objects are copied,
 * never changed in place; beyond MAX_DEPTH or MAX_NODES what is left is masked whole.
 */
export function redactValue<T>(value: T): T {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number, secret: boolean): unknown => {
    nodes += 1;
    if (typeof v === "string") return secret ? (v ? REDACTED : v) : redactText(v);
    if (typeof v === "number" || typeof v === "bigint") return secret ? REDACTED : v;
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v;
    if (depth >= MAX_DEPTH || nodes > MAX_NODES) return REDACTED;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    try {
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1, secret));
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(v)) out[key] = walk(item, depth + 1, secret || isCredentialKey(key));
      return out;
    } finally {
      seen.delete(v);
    }
  };
  return walk(value, 0, false) as T;
}

// ------------------------------------------------------------------------------------ errors

/**
 * An error as the server's log shows it (its stack, its code and what caused it), masked: for
 * `console.*`, where an error from a fetch or a remote server can quote an address or a header.
 */
export function redactError(error: unknown, depth = 0): string {
  if (error instanceof Error) {
    const head = error.stack?.includes(error.message) ? error.stack : `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;
    const code = (error as { code?: unknown }).code;
    let out = redactText(head) + (typeof code === "string" || typeof code === "number" ? ` (code ${redactText(String(code))})` : "");
    if (error.cause !== undefined && depth < 3) out += `\n[cause] ${redactError(error.cause, depth + 1)}`;
    return out;
  }
  if (typeof error === "string") return redactText(error);
  try {
    return JSON.stringify(redactValue(error)) ?? String(error);
  } catch {
    return redactText(String(error));
  }
}
