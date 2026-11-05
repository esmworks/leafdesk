import { getLocale, getTranslations } from "next-intl/server";
import { auth } from "@/lib/auth";
import { ImportError } from "@/lib/import/result";
import { SKILL_IMPORT_LIMITS } from "@/lib/skill-import";
import { AccessError } from "@/server/access";
import { isCrossSite } from "@/server/cross-site";
import { startImport } from "@/server/import/place";
import { importSkills, requireSkillImport } from "@/server/skill-import";
import { SkillError } from "@/server/skills";
import { TeamspaceError } from "@/server/teamspaces";

/**
 * Imports skills into the person's skills database (server/skill-import.ts): `POST
 * /api/skills/import` with a multipart form of `workspaceId` and one or more `file`s (SKILL.md or
 * other Markdown files, or ZIPs of skill folders), answered with `{ skills, skippedFiles }` or
 * `{ error, code }`. Like /api/import: the `X-Leafdesk-Import` header (no cross-site form sends it),
 * the place checked before any file is read, one import at a time per person.
 */
export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (!session) return fail(401, "noAccess", "Sign in to import");
  if (isCrossSite(request, "x-leafdesk-import")) return fail(403, "badRequest", "Cross-site imports aren't allowed");
  const length = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(length)) return fail(411, "badRequest", "Send the form with a Content-Length");
  // Some room over the files' limit for the form's own fields and boundaries.
  if (length > SKILL_IMPORT_LIMITS.uploadBytes + 64 * 1024) return fail(413, "importTooLarge", await message("importTooLarge"));

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "badRequest", "Send the files as a multipart form");
  }
  const workspaceId = form.get("workspaceId");
  const uploads = form.getAll("file").filter((f): f is File => typeof f !== "string");
  if (typeof workspaceId !== "string" || !workspaceId) return fail(400, "badRequest", "Say which workspace");
  if (!uploads.length) return fail(400, "noSkills", await message("noSkills"));

  const userId = session.user.id;
  let release: (() => void) | null = null;
  try {
    await requireSkillImport(userId, workspaceId);
    release = startImport(userId);
    const files = await Promise.all(uploads.map(async (f) => ({ path: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
    const result = await importSkills(userId, workspaceId, files, await getLocale());
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SkillError) return fail(400, error.code, await message(error.code));
    if (error instanceof ImportError && error.code === "busy") return fail(429, "busy", await message("busy"));
    if (error instanceof AccessError || error instanceof TeamspaceError) return fail(403, "noAccess", (await getTranslations())("database.errors.accessDenied"));
    console.error("[skill import]", error);
    return fail(500, "failed", (await getTranslations())("common.genericError"));
  } finally {
    release?.();
  }
}

async function message(code: string): Promise<string> {
  const t = await getTranslations("skills.errors");
  return t(code as Parameters<typeof t>[0], { max: SKILL_IMPORT_LIMITS.skills, mb: SKILL_IMPORT_LIMITS.uploadBytes / 1024 / 1024 });
}

function fail(status: number, code: string, error: string) {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
