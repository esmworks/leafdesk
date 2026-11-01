/**
 * Logos of the domains mail comes from, for the marks beside the Mail list's conversations
 * (lib/sender-marks.ts). The list reads what is known of the domains of verified senders it shows
 * (`knownLogos`) and asks for those never looked at (`wantLogos`); a background job fetches the
 * ones due (`runSenderLogos`), a few at a time, never while someone waits: first the domain's BIMI
 * record, the logo it publishes for its mail, else the largest icon its web site names. Fetches go
 * through the same guard as saving a web page (connections/fetch.ts with `web` and `untrusted`),
 * since the domain is whatever a sender wrote; nothing about the mailbox goes with them.
 * SENDER_LOGOS=off stops it all. A logo's address is signed for the person it was listed to, so the
 * cache, shared by every workspace, doesn't tell anyone else which domains mail came from.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { asc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { mailSenderLogo } from "@/db/schema";
import { env } from "@/lib/env";
import {
  bimiLocation,
  logoWidth,
  MAX_LOGO_BYTES,
  MIN_LOGO_WIDTH,
  organizationDomain,
  plainSvg,
  sniffLogo,
  type LogoFormat,
} from "@/lib/sender-marks";
import { AnswerTooLargeError, capResponse, connectionFetch, ConnectionFetchError } from "@/server/connections/fetch";
import { decodePage } from "@/server/link-preview";
import { decodeEntities, headOf, tagAttributes } from "@/server/link-meta";
import { startSweep } from "@/server/sweep";

const SWEEP_INTERVAL_MS = 60_000;
/** Domains looked at per round, and at most this many at once. */
const PER_ROUND = 12;
const AT_ONCE = 4;
const TIMEOUT_MS = 8_000;
/** Bytes of a home page read at most for the icons its head names; reading stops at `</head>`. */
const PAGE_BYTES = 512 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A logo found is looked at again after this long; a domain without one sooner, as it may get one. */
const FOUND_AGAIN_MS = 30 * DAY_MS;
const NONE_AGAIN_MS = 7 * DAY_MS;
/** A domain that couldn't be reached keeps what it had and is tried again after this long. */
const UNREACHABLE_AGAIN_MS = DAY_MS;

const USER_AGENT = "Mozilla/5.0 (compatible; LeafdeskBot/1.0; sender logo)";

/** Whether this server looks up senders' logos at all (SENDER_LOGOS). */
export const senderLogosEnabled = () => env.senderLogos;

/** Notes that the list showed verified senders of these domains: those never looked at wait for the job. */
export async function wantLogos(domains: string[]) {
  const unique = [...new Set(domains)];
  if (!unique.length) return;
  await db
    .insert(mailSenderLogo)
    .values(unique.map((domain) => ({ domain })))
    .onConflictDoNothing();
}

/**
 * What is known of these domains: those with a logo, by when it was fetched (the version its
 * address carries), and null for those looked at, or waiting to be, without one. Domains missing
 * from the map were never asked for.
 */
export async function knownLogos(domains: string[]): Promise<Map<string, number | null>> {
  const unique = [...new Set(domains)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ domain: mailSenderLogo.domain, checkedAt: mailSenderLogo.checkedAt, found: mailSenderLogo.imageType })
    .from(mailSenderLogo)
    .where(inArray(mailSenderLogo.domain, unique));
  return new Map(rows.map((r) => [r.domain, r.found ? (r.checkedAt?.getTime() ?? 0) : null]));
}

/** The signature of a logo's address for the person it was listed to. */
const logoKey = (userId: string, domain: string) => createHmac("sha256", env.authSecret).update(`sender-logo:${userId}:${domain}`).digest("base64url").slice(0, 22);

/** Whether `key` is the signature of a domain's logo address for this person. */
export function logoKeyValid(userId: string, domain: string, key: string | null) {
  const expected = Buffer.from(logoKey(userId, domain));
  const given = Buffer.from(key ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Where the mark shown to `userId` loads a domain's logo from (app/api/mail/logos/[domain]). */
export const logoUrl = (userId: string, domain: string, version: number) =>
  `/api/mail/logos/${encodeURIComponent(domain)}?v=${version.toString(36)}&k=${logoKey(userId, domain)}`;

/** A domain's logo as kept, for the route that serves it. */
export async function storedLogo(domain: string) {
  const [row] = await db.select({ image: mailSenderLogo.image, imageType: mailSenderLogo.imageType }).from(mailSenderLogo).where(eq(mailSenderLogo.domain, domain));
  return row?.image && row.imageType ? { image: row.image, type: row.imageType } : null;
}

type Found = { bytes: Uint8Array; format: LogoFormat };

/** One domain's look-up: whether some answer didn't come (a timeout, a server error), so finding nothing proves nothing. */
type Lookup = { unreachable: boolean };

/** Reads a body up to `maxBytes`, stopping early once `untilText` has come; the rest is never fetched. */
async function readPart(body: ReadableStream<Uint8Array>, maxBytes: number, untilText: RegExp): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (untilText.test(Buffer.from(value).toString("latin1"))) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new Uint8Array(Buffer.concat(chunks).subarray(0, maxBytes));
}

/**
 * The bytes at `url`: all of them, refused past `maxBytes`, or for a page only its start, up to its
 * `</head>`. Null when there are none to use; an answer that didn't come marks `lookup` unreachable.
 */
async function fetchBytes(url: string, maxBytes: number, lookup: Lookup, page = false): Promise<{ bytes: Uint8Array; url: string; type: string } | null> {
  try {
    const answer = await connectionFetch(url, { headers: { "user-agent": USER_AGENT, accept: "image/*,text/html;q=0.9,*/*;q=0.5" }, signal: AbortSignal.timeout(TIMEOUT_MS) }, { web: true, untrusted: true });
    // Where redirects led, which the page's relative icon addresses go by.
    const final = answer.url || url;
    if (!answer.ok || !answer.body) {
      if (answer.status >= 500 || answer.status === 429) lookup.unreachable = true;
      await answer.body?.cancel().catch(() => undefined);
      return null;
    }
    const type = answer.headers.get("content-type") ?? "";
    const bytes = page ? await readPart(answer.body, maxBytes, /<\/head\s*>|<body[\s>]/i) : new Uint8Array(await capResponse(answer, maxBytes).arrayBuffer());
    return { bytes, url: final, type };
  } catch (error) {
    // An address refused or an answer too large is the domain's own; anything else may pass.
    if (!(error instanceof ConnectionFetchError || error instanceof AnswerTooLargeError)) lookup.unreachable = true;
    return null;
  }
}

/** The bytes at `url` when they are a logo worth showing: a known format, wide enough, an SVG only when plain. */
async function logoAt(url: string, lookup: Lookup): Promise<Found | null> {
  const got = await fetchBytes(url, MAX_LOGO_BYTES, lookup);
  if (!got?.bytes.length) return null;
  const format = sniffLogo(got.bytes);
  if (!format) return null;
  if (format === "svg") return plainSvg(new TextDecoder().decode(got.bytes)) ? { bytes: got.bytes, format } : null;
  const width = logoWidth(got.bytes, format);
  return width !== null && width < MIN_LOGO_WIDTH ? null : { bytes: got.bytes, format };
}

/** DNS answers that say a name has no such record, as opposed to no answer. */
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

/** The logo a domain's BIMI record points at (the domain's own record, else its organization's). */
async function bimiLogo(domain: string, lookup: Lookup): Promise<Found | null> {
  for (const name of [...new Set([domain, organizationDomain(domain)])]) {
    let records: string[][] = [];
    try {
      records = await resolveTxt(`default._bimi.${name}`);
    } catch (error) {
      if (!NO_RECORD.has((error as NodeJS.ErrnoException).code ?? "")) lookup.unreachable = true;
      continue;
    }
    for (const record of records) {
      const location = bimiLocation(record.join(""));
      if (location) return logoAt(location, lookup);
    }
  }
  return null;
}

/** Icons a home page's head names, the likeliest to be large first: touch icons, then icons by their stated size. */
export function pageIcons(html: string, pageUrl: string): string[] {
  const icons: { href: string; rank: number }[] = [];
  const address = (href: string, base: string) => {
    try {
      const url = new URL(decodeEntities(href).trim(), base);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  };
  let base = pageUrl;
  for (const match of headOf(html).matchAll(/<(link|base)\b[^>]*>/gi)) {
    const attrs = tagAttributes(match[0]);
    if (!attrs.href) continue;
    if (match[1].toLowerCase() === "base") {
      base = address(attrs.href, pageUrl) ?? base;
      continue;
    }
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    const size = Math.max(0, ...(attrs.sizes ?? "").split(/\s+/).map((s) => Number.parseInt(s, 10) || 0));
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) icons.push({ href: attrs.href, rank: 10_000 + size });
    else if (rel.includes("icon")) icons.push({ href: attrs.href, rank: attrs.type === "image/svg+xml" || /\.svg(\?|$)/i.test(attrs.href) ? 5_000 : size });
  }
  const out: string[] = [];
  for (const icon of icons.sort((a, b) => b.rank - a.rank)) {
    const url = address(icon.href, base);
    if (url && !out.includes(url)) out.push(url);
  }
  return out;
}

/** The largest icon the organization's web site offers. */
async function siteLogo(domain: string, lookup: Lookup): Promise<Found | null> {
  const site = organizationDomain(domain);
  for (const home of [`https://${site}/`, `https://www.${site}/`]) {
    const page = await fetchBytes(home, PAGE_BYTES, lookup, true);
    if (!page) continue;
    const html = decodePage(Buffer.from(page.bytes), page.type);
    const candidates = [...pageIcons(html, page.url), new URL("/apple-touch-icon.png", page.url).href, new URL("/favicon.ico", page.url).href];
    for (const url of candidates.slice(0, 6)) {
      const found = await logoAt(url, lookup);
      if (found) return found;
    }
    return null;
  }
  return null;
}

/**
 * Looks one domain's logo up and keeps what was found, or that none was. When some answer didn't
 * come, finding nothing changes nothing (a logo found before stays) and it is tried again tomorrow.
 */
export async function checkLogo(domain: string, now = new Date()) {
  const lookup: Lookup = { unreachable: false };
  const found = (await bimiLogo(domain, lookup)) ?? (await siteLogo(domain, lookup));
  if (!found && lookup.unreachable) {
    await db
      .update(mailSenderLogo)
      .set({ nextCheckAt: new Date(now.getTime() + UNREACHABLE_AGAIN_MS) })
      .where(eq(mailSenderLogo.domain, domain));
    return;
  }
  await db
    .update(mailSenderLogo)
    .set({
      image: found?.bytes ?? null,
      imageType: found?.format ?? null,
      checkedAt: now,
      nextCheckAt: new Date(now.getTime() + (found ? FOUND_AGAIN_MS : NONE_AGAIN_MS)),
    })
    .where(eq(mailSenderLogo.domain, domain));
}

/** One round: the domains due, AT_ONCE at a time. */
export async function runSenderLogos(now = new Date()) {
  const due = await db
    .select({ domain: mailSenderLogo.domain })
    .from(mailSenderLogo)
    .where(lte(mailSenderLogo.nextCheckAt, now))
    .orderBy(asc(mailSenderLogo.nextCheckAt))
    .limit(PER_ROUND);
  for (let i = 0; i < due.length; i += AT_ONCE) {
    await Promise.all(
      due.slice(i, i + AT_ONCE).map(({ domain }) =>
        checkLogo(domain, now).catch(async (error) => {
          console.warn(`[mail-client] could not look up the logo of ${domain}:`, (error as Error)?.message ?? error);
          await db
            .update(mailSenderLogo)
            .set({ nextCheckAt: new Date(now.getTime() + UNREACHABLE_AGAIN_MS) })
            .where(eq(mailSenderLogo.domain, domain));
        }),
      ),
    );
  }
}

export function startSenderLogos() {
  if (!senderLogosEnabled()) return () => undefined;
  return startSweep(SWEEP_INTERVAL_MS, () => runSenderLogos(), "could not look up senders' logos");
}
