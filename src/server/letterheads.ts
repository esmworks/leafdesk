import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { pdfLetterhead } from "@/db/schema";
import { isGuest, requireMembership } from "@/server/access";
import type { PdfLetterhead } from "@/server/pdf-document";
import { imageType, MAX_LETTERHEADS, MAX_LOGO_BYTES, parseLetterhead, sameLetterheadName, type Letterhead, type LetterheadProblem } from "@/lib/letterheads";

/**
 * A workspace's letterheads (lib/letterheads): its owners add, change and remove them and pick the
 * default; its members list them and print PDFs in them. Guests do neither: a PDF they make has no
 * letterhead, so nobody outside the workspace makes papers in its name.
 */

export type LetterheadErrorCode = LetterheadProblem | "duplicateName" | "tooMany" | "logoType" | "logoSize" | "notFound";

export class LetterheadError extends Error {
  constructor(
    readonly code: LetterheadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LetterheadError";
  }
}

const listed = {
  id: pdfLetterhead.id,
  workspaceId: pdfLetterhead.workspaceId,
  name: pdfLetterhead.name,
  header: pdfLetterhead.header,
  footer: pdfLetterhead.footer,
  logoPlace: pdfLetterhead.logoPlace,
  accent: pdfLetterhead.accent,
  pageNumbers: pdfLetterhead.pageNumbers,
  isDefault: pdfLetterhead.isDefault,
  logoType: pdfLetterhead.logoType,
  logoUpdatedAt: pdfLetterhead.logoUpdatedAt,
};

type Listed = Pick<typeof pdfLetterhead.$inferSelect, keyof typeof listed>;

function shown(row: Listed): Letterhead {
  return {
    id: row.id,
    name: row.name,
    header: row.header,
    footer: row.footer,
    logoPlace: row.logoPlace,
    accent: row.accent,
    pageNumbers: row.pageNumbers,
    isDefault: row.isDefault,
    hasLogo: !!row.logoType,
    logoVersion: row.logoUpdatedAt ? String(row.logoUpdatedAt.getTime()) : null,
  };
}

async function rowsOf(workspaceId: string): Promise<Listed[]> {
  return db.select(listed).from(pdfLetterhead).where(eq(pdfLetterhead.workspaceId, workspaceId)).orderBy(asc(pdfLetterhead.createdAt), asc(pdfLetterhead.id));
}

/** The workspace's letterheads, oldest first; none for guests. */
export async function listLetterheads(userId: string, workspaceId: string): Promise<Letterhead[]> {
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role)) return [];
  return (await rowsOf(workspaceId)).map(shown);
}

/** A letterhead and its workspace, for an owner of that workspace (else NotFound, the same way whether missing or not theirs). */
async function ownedLetterhead(userId: string, letterheadId: string): Promise<Listed> {
  const [row] = await db.select(listed).from(pdfLetterhead).where(eq(pdfLetterhead.id, letterheadId)).limit(1);
  if (!row) throw new LetterheadError("notFound", "No such letterhead");
  try {
    await requireMembership(userId, row.workspaceId, "owner");
  } catch {
    throw new LetterheadError("notFound", "No such letterhead");
  }
  return row;
}

function checked(input: unknown) {
  const parsed = parseLetterhead(input);
  if (!parsed.ok) throw new LetterheadError(parsed.problem, `The letterhead's ${parsed.problem} isn't valid`);
  return parsed.fields;
}

function nameTaken(rows: Listed[], name: string, except?: string) {
  if (rows.some((row) => row.id !== except && sameLetterheadName(row.name, name))) {
    throw new LetterheadError("duplicateName", "Another letterhead has that name");
  }
}

/** Adds a letterhead; owners only. The workspace's first becomes its default. */
export async function createLetterhead(userId: string, workspaceId: string, input: unknown): Promise<Letterhead> {
  await requireMembership(userId, workspaceId, "owner");
  const fields = checked(input);
  return db.transaction(async (tx) => {
    const rows = await tx.select(listed).from(pdfLetterhead).where(eq(pdfLetterhead.workspaceId, workspaceId)).for("update");
    if (rows.length >= MAX_LETTERHEADS) throw new LetterheadError("tooMany", `A workspace has at most ${MAX_LETTERHEADS} letterheads`);
    nameTaken(rows, fields.name);
    const [row] = await tx
      .insert(pdfLetterhead)
      .values({ workspaceId, ...fields, isDefault: rows.length === 0, createdBy: userId })
      .returning(listed);
    return shown(row);
  });
}

/** Changes a letterhead's fields (not its logo); owners only. */
export async function updateLetterhead(userId: string, letterheadId: string, input: unknown): Promise<Letterhead> {
  const current = await ownedLetterhead(userId, letterheadId);
  const fields = checked(input);
  nameTaken(await rowsOf(current.workspaceId), fields.name, letterheadId);
  const [row] = await db.update(pdfLetterhead).set(fields).where(eq(pdfLetterhead.id, letterheadId)).returning(listed);
  return shown(row);
}

/** Removes a letterhead; owners only. PDFs then use the default (none when it was the default). */
export async function deleteLetterhead(userId: string, letterheadId: string): Promise<void> {
  await ownedLetterhead(userId, letterheadId);
  await db.delete(pdfLetterhead).where(eq(pdfLetterhead.id, letterheadId));
}

/** Makes a letterhead the workspace's default, or with `isDefault` false, leaves the workspace without one; owners only. */
export async function setDefaultLetterhead(userId: string, letterheadId: string, isDefault: boolean): Promise<void> {
  const current = await ownedLetterhead(userId, letterheadId);
  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx
        .update(pdfLetterhead)
        .set({ isDefault: false })
        .where(and(eq(pdfLetterhead.workspaceId, current.workspaceId), eq(pdfLetterhead.isDefault, true), ne(pdfLetterhead.id, letterheadId)));
    }
    await tx.update(pdfLetterhead).set({ isDefault }).where(eq(pdfLetterhead.id, letterheadId));
  });
}

/** Puts a logo on a letterhead (PNG or JPEG, at most MAX_LOGO_BYTES), or with null takes it off; owners only. */
export async function setLetterheadLogo(userId: string, letterheadId: string, bytes: Buffer | null): Promise<Letterhead> {
  await ownedLetterhead(userId, letterheadId);
  let logo: { logo: Buffer | null; logoType: string | null; logoUpdatedAt: Date | null } = { logo: null, logoType: null, logoUpdatedAt: null };
  if (bytes) {
    if (bytes.length > MAX_LOGO_BYTES) throw new LetterheadError("logoSize", "The logo is too large");
    const type = imageType(bytes);
    if (!type) throw new LetterheadError("logoType", "A logo must be a PNG or JPEG image");
    logo = { logo: bytes, logoType: type, logoUpdatedAt: new Date() };
  }
  const [row] = await db.update(pdfLetterhead).set(logo).where(eq(pdfLetterhead.id, letterheadId)).returning(listed);
  return shown(row);
}

/** A letterhead's logo for one of its workspace's members (not guests); null when there is none or it isn't theirs. */
export async function letterheadLogo(userId: string, letterheadId: string): Promise<{ bytes: Buffer; type: string } | null> {
  const [row] = await db
    .select({ workspaceId: pdfLetterhead.workspaceId, logo: pdfLetterhead.logo, logoType: pdfLetterhead.logoType })
    .from(pdfLetterhead)
    .where(eq(pdfLetterhead.id, letterheadId))
    .limit(1);
  if (!row?.logo || !row.logoType) return null;
  const membership = await requireMembership(userId, row.workspaceId).catch(() => null);
  if (!membership || isGuest(membership.role)) return null;
  return { bytes: Buffer.from(row.logo), type: row.logoType };
}

/**
 * Which letterhead a PDF of `workspaceId` made by `userId` prints in: `choice` is a letterhead's
 * id, "none", or undefined for the workspace's default. Null for none, and always for guests.
 * Throws LetterheadError("notFound") for an id that isn't one of the workspace's.
 */
export async function letterheadForPdf(userId: string, workspaceId: string, choice: string | undefined): Promise<PdfLetterhead | null> {
  if (choice === "none") return null;
  const membership = await requireMembership(userId, workspaceId);
  if (isGuest(membership.role)) return null;
  const [row] = await db
    .select()
    .from(pdfLetterhead)
    .where(and(eq(pdfLetterhead.workspaceId, workspaceId), choice === undefined ? eq(pdfLetterhead.isDefault, true) : eq(pdfLetterhead.id, choice)))
    .limit(1);
  if (!row) {
    if (choice === undefined) return null;
    throw new LetterheadError("notFound", "No such letterhead");
  }
  return {
    logo: row.logo && row.logoType ? `data:${row.logoType};base64,${Buffer.from(row.logo).toString("base64")}` : null,
    logoPlace: row.logoPlace,
    header: row.header,
    footer: row.footer,
    accent: row.accent,
    pageNumbers: row.pageNumbers,
  };
}
