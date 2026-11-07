/**
 * Pages exported in bulk (server/mass-export.ts): how many page exports and prints someone other
 * than an owner makes within MASS_EXPORT_WINDOW_MS before the workspace's owners hear of it, and
 * the `mass_export` inbox item's `message`: the count and the person, whose exports the audit log
 * opens at.
 */
export const MASS_EXPORT_PAGES = 20;
export const MASS_EXPORT_WINDOW_MS = 60 * 60_000;

export type MassExport = { count: number; actorId: string };

export const massExportMessage = (notice: MassExport) => `pages:${notice.count}:${notice.actorId}`;

export function parseMassExport(message: string | null | undefined): MassExport | null {
  const match = /^pages:(\d{1,9}):([\w-]{1,128})$/.exec(message ?? "");
  return match ? { count: Number(match[1]), actorId: match[2] } : null;
}

/** The audit log at that person's exports, where the owner sees what they took. */
export const massExportPath = (workspaceId: string, notice: MassExport | null) =>
  `/w/${workspaceId}/settings?tab=audit&category=exports${notice ? `&actor=${encodeURIComponent(`u:${notice.actorId}`)}` : ""}`;
