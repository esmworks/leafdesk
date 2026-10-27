import type { PdfTheme } from "@/lib/pdf-themes";

/**
 * Letterheads: what a workspace's PDF files (server/pdf.ts) print around a page, set up by its
 * owners in Settings > PDF templates. A letterhead has a name (what the page menu and the AI chat
 * pick it by), a logo (PNG or JPEG, kept in the database with it, never a URL), lines at the top of
 * every page beside the logo (the first in bold: the company's name, then its address, tax number
 * …), lines at the foot, an accent color for the rules and table headers, and page numbers. One of
 * a workspace's letterheads may be its default, which PDFs use unless another (or none) is picked.
 * A letterhead may have a theme (lib/pdf-themes) instead of its lines and accent: then the theme
 * lays the paper out, the logo where its elements put it.
 *
 * Pure and client-safe.
 */

export const LOGO_PLACES = ["left", "center", "right"] as const;
export type LogoPlace = (typeof LOGO_PLACES)[number];

/** What an owner writes; the logo goes up on its own (see server/letterheads.ts). */
export type LetterheadFields = {
  name: string;
  /** Lines at the top of every page, one per line; the first prints in bold. */
  header: string;
  /** Lines at the foot of every page. */
  footer: string;
  logoPlace: LogoPlace;
  /** A color as `#rrggbb` for the rules and table headers; "" for the usual gray. */
  accent: string;
  /** "n / total" at the foot of every page. */
  pageNumbers: boolean;
};

/** A letterhead as the settings and pickers list it. */
export type Letterhead = LetterheadFields & {
  id: string;
  isDefault: boolean;
  /** Whether it has a logo; its bytes are served on their own. */
  hasLogo: boolean;
  /** Changes with the logo, so its URL can be cached. */
  logoVersion: string | null;
  /** Its theme, set on its own (server/letterheads.ts setLetterheadTheme); null for none. */
  theme: PdfTheme | null;
};

export const MAX_LETTERHEADS = 20;
export const MAX_LETTERHEAD_NAME = 60;
export const MAX_HEADER_LINES = 6;
export const MAX_FOOTER_LINES = 4;
export const MAX_LINE = 140;
/** The largest logo, in bytes: it is drawn small, and read into every PDF. */
export const MAX_LOGO_BYTES = 512 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg"] as const;

const COLOR = /^#[0-9a-f]{6}$/;

export type LetterheadProblem = "name" | "header" | "footer" | "logoPlace" | "accent";

/** Text as lines: trimmed, empty lines at either end dropped, at most `max` of at most MAX_LINE characters each; null when too many or too long. */
export function letterheadLines(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (lines.length > max || lines.some((line) => [...line].length > MAX_LINE)) return null;
  return lines.join("\n");
}

/** A letterhead's name as stored: one line, trimmed; null when empty or too long. */
export function letterheadName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  return name && [...name].length <= MAX_LETTERHEAD_NAME ? name : null;
}

/** The fields an owner saves, checked and tidied. */
export function parseLetterhead(value: unknown): { ok: true; fields: LetterheadFields } | { ok: false; problem: LetterheadProblem } {
  const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const name = letterheadName(item.name);
  if (!name) return { ok: false, problem: "name" };
  const header = letterheadLines(item.header, MAX_HEADER_LINES);
  if (header === null) return { ok: false, problem: "header" };
  const footer = letterheadLines(item.footer, MAX_FOOTER_LINES);
  if (footer === null) return { ok: false, problem: "footer" };
  const logoPlace = item.logoPlace ?? "left";
  if (!(LOGO_PLACES as readonly unknown[]).includes(logoPlace)) return { ok: false, problem: "logoPlace" };
  const accent = typeof item.accent === "string" ? item.accent.trim().toLowerCase() : item.accent === undefined || item.accent === null ? "" : null;
  if (accent === null || (accent && !COLOR.test(accent))) return { ok: false, problem: "accent" };
  return { ok: true, fields: { name, header, footer, logoPlace: logoPlace as LogoPlace, accent, pageNumbers: item.pageNumbers !== false } };
}

/** The same name, as the chat and pickers match it: case and spacing don't count. */
export function sameLetterheadName(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLocaleLowerCase("en");
  return norm(a) === norm(b);
}

/** A color a share of the way to white, for fills under text in the accent. */
export function tint(color: string, share: number): string {
  if (!COLOR.test(color)) return color;
  const channel = (i: number) => {
    const value = parseInt(color.slice(i, i + 2), 16);
    return Math.round(value + (255 - value) * share)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

/** PNG or JPEG by the file's first bytes (what PDFs draw); null otherwise. */
export function imageType(bytes: Uint8Array): (typeof LOGO_TYPES)[number] | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 8 && png.every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}
