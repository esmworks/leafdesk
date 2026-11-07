/**
 * Rows trashed in bulk (server/mass-trash.ts): how many rows of one database someone other than an
 * owner moves to the trash within MASS_TRASH_WINDOW_MS before the workspace's owners hear of it,
 * and the `mass_trash` inbox item's `message`, which says what went and how many rows.
 */
export const MASS_TRASH_ROWS = 20;
export const MASS_TRASH_WINDOW_MS = 60 * 60_000;

export type MassTrash = { what: "rows" | "database"; count: number };

export const massTrashMessage = (notice: MassTrash) => `${notice.what}:${notice.count}`;

export function parseMassTrash(message: string | null | undefined): MassTrash | null {
  const match = /^(rows|database):(\d{1,9})$/.exec(message ?? "");
  return match ? { what: match[1] as MassTrash["what"], count: Number(match[2]) } : null;
}
