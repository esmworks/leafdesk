/**
 * Skills brought from elsewhere: a SKILL.md, or a ZIP of skill folders as AI assistants keep them
 * (what *Export as SKILL.md* writes, or several such folders). Each SKILL.md becomes a row of the
 * person's skills database, as *New skill* makes one (server/skills.ts createSkill): its front
 * matter's description in the Description property, its body as the page, and the other files of
 * its folder (scripts, references, templates) in the database's files property, when it has one.
 *
 * The upload is untrusted: it is unpacked by the import's archive reader (import/archive.ts
 * collectFiles: bounded sizes, no paths out of the archive), read by hand (lib/skill-import.ts) and
 * held to SKILL_IMPORT_LIMITS. Files go through storeFile, so the workspace's file limits and
 * storage quota hold; a file refused there is left out and counted, the skill kept.
 */
import { Readable } from "node:stream";
import { ImportError } from "@/lib/import/result";
import { findSkills, parseSkillMarkdown, SKILL_IMPORT_LIMITS } from "@/lib/skill-import";
import { getProperties, updateRowProperties } from "@/server/databases";
import { FileError, storeFile } from "@/server/files";
import { collectFiles, type UploadedFile } from "@/server/import/archive";
import { AccessError, requireMembership } from "@/server/access";
import { createSkill, findSkillDatabase, SkillError } from "@/server/skills";
import { topLevelAccess } from "@/server/workspaces";

export type ImportedSkills = {
  skills: { id: string; title: string; databaseId: string }[];
  /** Files beside a skill left out: over the limit per skill, or refused by the workspace's file limits. */
  skippedFiles: number;
};

const utf8 = new TextDecoder("utf-8", { fatal: false });

/**
 * Refused (AccessError) unless the person may add skills in the workspace, as the library's New skill
 * button: they have a skills database, or may make one at the top of the workspace. Checked before
 * the upload is read.
 */
export async function requireSkillImport(userId: string, workspaceId: string): Promise<void> {
  await requireMembership(userId, workspaceId);
  const [topLevel, database] = await Promise.all([topLevelAccess(userId, workspaceId), findSkillDatabase(userId, workspaceId)]);
  if (topLevel === null && database === null) throw new AccessError();
}

/** Makes the skills an upload holds (see the top of this file), in the person's skills database. */
export async function importSkills(userId: string, workspaceId: string, upload: UploadedFile[], locale?: string): Promise<ImportedSkills> {
  const size = upload.reduce((sum, f) => sum + f.data.byteLength, 0);
  if (size > SKILL_IMPORT_LIMITS.uploadBytes) throw new SkillError("importTooLarge", "The upload is too large");
  let files: Map<string, Uint8Array>;
  try {
    files = collectFiles(upload).files;
  } catch (error) {
    if (error instanceof ImportError) throw new SkillError("badFile", error.message);
    throw error;
  }
  const found = findSkills([...files.keys()]);
  if (!found.length) throw new SkillError("noSkills", "No SKILL.md or Markdown file in the upload");
  if (found.length > SKILL_IMPORT_LIMITS.skills) throw new SkillError("tooManySkills", `At most ${SKILL_IMPORT_LIMITS.skills} skills at once`);
  // Every file is read before anything is made, so a SKILL.md too long stops the import whole.
  const parsed = found.map((skill) => {
    const text = utf8.decode(files.get(skill.path)!);
    if (text.length > SKILL_IMPORT_LIMITS.skillChars) throw new SkillError("skillTooLong", `${skill.path} is too long`);
    return { ...skill, ...parseSkillMarkdown(text, skill.fallback) };
  });

  const made: ImportedSkills["skills"] = [];
  let skippedFiles = 0;
  let filesProperty: string | null | undefined;
  for (const skill of parsed) {
    const created = await createSkill(userId, workspaceId, { title: skill.title, markdown: skill.body, description: skill.description }, locale);
    made.push({ id: created.id, title: skill.title, databaseId: created.databaseId });
    if (!skill.files.length) continue;
    filesProperty ??= (await getProperties(created.databaseId)).find((p) => p.type === "files")?.id ?? null;
    if (!filesProperty) {
      skippedFiles += skill.files.length;
      continue;
    }
    const kept = skill.files.slice(0, SKILL_IMPORT_LIMITS.filesPerSkill);
    skippedFiles += skill.files.length - kept.length;
    const values: { url: string; name: string; type: string }[] = [];
    const folder = skill.path.slice(0, skill.path.lastIndexOf("/") + 1);
    for (const path of kept) {
      const data = files.get(path)!;
      try {
        // Named by its file name (storeFile keeps the last part of the path).
        const stored = await storeFile(
          { workspaceId, pageId: created.id, uploadedBy: userId },
          { name: path.slice(folder.length), body: Readable.from(Buffer.from(data)), declaredSize: data.byteLength },
        );
        values.push({ url: stored.url, name: stored.name, type: stored.contentType });
      } catch (error) {
        if (!(error instanceof FileError)) throw error;
        skippedFiles++;
      }
    }
    if (values.length) await updateRowProperties(userId, created.id, { [filesProperty]: values });
  }
  return { skills: made, skippedFiles };
}
