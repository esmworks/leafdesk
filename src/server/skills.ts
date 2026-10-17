/**
 * Skills: reusable instructions kept as pages. Any page or database row can be marked as a skill
 * by someone who may edit it; its body is the instructions and its description says what it is
 * for. Skills are offered in the workspace's skills library, to MCP clients as prompts (and the
 * list_skills / get_skill tools) and in the AI chat, always to the people who can open the page:
 * there is no access of their own. Templates and pages inside them are never skills; a skill in
 * the trash keeps its mark but leaves every list until it is restored.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { page } from "@/db/schema";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import { pageLabel } from "@/lib/labels";
import { requireMembership, requirePageAccess } from "@/server/access";
import { getCollab } from "@/server/collab/bridge";
import { labelPageLinks } from "@/server/mentions";
import { expandSyncedMarkdown } from "@/server/synced-blocks";
import { listWorkspaces } from "@/server/workspaces";
import { describeSkill, MAX_SKILL_DESCRIPTION, skillNames, skillSlug } from "@/lib/skills";

export { MAX_SKILL_DESCRIPTION } from "@/lib/skills";

export type SkillErrorCode = "notAPage" | "template" | "inTrash" | "tooLong" | "notASkill";

export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}

/**
 * SQL condition: the page (aliased in a raw query) is a skill: marked, a page or row rather than a
 * database, not in the trash, not a template or in one.
 */
export function isSkill(alias: string): SQL {
  if (!/^[a-z_]+$/.test(alias)) throw new Error(`Bad table alias: ${alias}`);
  return sql.raw(`("${alias}".is_skill and "${alias}".kind = 'page' and "${alias}".archived_at is null and not "${alias}".in_template)`);
}

export type SkillSummary = {
  id: string;
  workspaceId: string;
  title: string;
  icon: string | null;
  /** The description, or the start of the body when it is empty. */
  description: string;
  /** Whether `description` was written for the skill (false: taken from the body). */
  described: boolean;
  /** The database a row skill belongs to, when the person can open it. */
  database: { id: string; title: string } | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Marks the page as a skill or not, and sets its description. Needs edit access, like the page's
 * other settings; templates (and pages in them) and databases can't be skills.
 */
export async function setSkill(userId: string, pageId: string, change: { skill?: boolean; description?: string }) {
  const found = await requirePageAccess(userId, pageId, "edit");
  if (found.kind !== "page") throw new SkillError("notAPage", "Only pages and database rows can be skills, not databases");
  if (found.isTemplate || found.inTemplate) throw new SkillError("template", "Templates and the pages in them can't be skills");
  if (found.archivedAt) throw new SkillError("inTrash", "Restore the page from the trash first");
  const description = change.description === undefined ? undefined : change.description.trim();
  if (description !== undefined && description.length > MAX_SKILL_DESCRIPTION) {
    throw new SkillError("tooLong", `A skill's description may have at most ${MAX_SKILL_DESCRIPTION} characters`);
  }
  const set: Partial<typeof page.$inferInsert> = {};
  if (change.skill !== undefined) set.isSkill = change.skill;
  if (description !== undefined) set.skillDescription = description;
  if (!Object.keys(set).length) return;
  await db.update(page).set(set).where(eq(page.id, pageId));
  const collab = getCollab();
  // Open tabs of the page and its database's views refetch the header.
  collab.broadcast(`page:${pageId}`, PAGE_HEADER_EVENT);
  if (found.parentId) collab.broadcast(`db:${found.parentId}`, "rows");
}

/** The skills of a workspace the person can open, by title. Guests get those shared with them. */
export async function listSkills(userId: string, workspaceId: string): Promise<SkillSummary[]> {
  await requireMembership(userId, workspaceId);
  const rows = await db.execute<{
    id: string;
    title: string;
    icon: string | null;
    skill_description: string;
    body: string;
    parent_id: string | null;
    parent_title: string | null;
    parent_kind: string | null;
    parent_open: boolean | null;
    created_at: Date | string;
    updated_at: Date | string;
  }>(sql`
    select p.id, p.title, p.icon, p.skill_description, left(p.content_text, 400) as body,
      p.parent_id, parent.title as parent_title, parent.kind as parent_kind,
      (parent.id is not null and page_access_level(${userId}, parent.id) > 0) as parent_open,
      p.created_at, p.updated_at
    from ${page} p
    left join ${page} parent on parent.id = p.parent_id
    where p.workspace_id = ${workspaceId} and ${isSkill("p")}
      and page_access_level(${userId}, p.id) > 0
    order by lower(p.title), p.created_at
  `);
  return rows.map((r) => ({
    id: r.id,
    workspaceId,
    title: r.title,
    icon: r.icon,
    ...describeSkill(r.skill_description, r.body),
    database: r.parent_kind === "database" && r.parent_open && r.parent_id ? { id: r.parent_id, title: r.parent_title ?? "" } : null,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  }));
}

export type NamedSkill = SkillSummary & { name: string; workspaceName: string };

/**
 * The skills of every workspace the person is in (that the connected app serving the request may
 * see), each with a name unique among them: the prompts an MCP client lists. Oldest first for the
 * names, then by title.
 */
export async function namedSkills(userId: string): Promise<NamedSkill[]> {
  const workspaces = await listWorkspaces(userId);
  const all = (await Promise.all(workspaces.map(async (w) => (await listSkills(userId, w.id)).map((s) => ({ ...s, workspaceName: w.name }))))).flat();
  const names = skillNames([...all].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)));
  return all.map((s) => ({ ...s, name: names.get(s.id) ?? skillSlug(s.title) }));
}

export type SkillContent = { id: string; workspaceId: string; title: string; description: string; body: string };

/**
 * A skill's instructions as the person may read them: the body as Markdown, with page links named
 * only where they can open the page (as MCP reads and exports do). Refused when the page isn't a
 * skill, is in the trash or is part of a template.
 */
export async function getSkillContent(userId: string, pageId: string): Promise<SkillContent> {
  const found = await requirePageAccess(userId, pageId, "view");
  if (!found.isSkill || found.archivedAt || found.inTemplate || found.kind !== "page") throw new SkillError("notASkill", "This page isn't a skill");
  const content = await getCollab().readPage(pageId);
  const body = await labelPageLinks(userId, await expandSyncedMarkdown(userId, pageId, content.markdown));
  return {
    id: found.id,
    workspaceId: found.workspaceId,
    title: pageLabel(content.title || found.title),
    description: describeSkill(found.skillDescription, content.text).description,
    body,
  };
}
