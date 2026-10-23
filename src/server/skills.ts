/**
 * Skills: reusable instructions kept as pages. Any page or database row can be marked as a skill
 * by someone who may edit it; its body is the instructions and its description says what it is
 * for. Skills are offered in the workspace's skills library, to MCP clients as prompts (and the
 * list_skills / get_skill tools) and in the AI chat, always to the people who can open the page:
 * there is no access of their own. Templates and pages inside them are never skills; a skill in
 * the trash keeps its mark but leaves every list until it is restored.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { databaseProperty, page } from "@/db/schema";
import { DEFAULT_LOCALE, isLocale } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { PAGE_HEADER_EVENT } from "@/lib/collab-constants";
import { pageLabel } from "@/lib/labels";
import { EDIT_RANK, requireMembership, requirePageAccess } from "@/server/access";
import { updateRowProperties } from "@/server/databases";
import { getCollab } from "@/server/collab/bridge";
import { labelPageLinks } from "@/server/mentions";
import { expandSyncedMarkdown } from "@/server/synced-blocks";
import { createPage, ENGLISH_SEED_NAMES } from "@/server/pages";
import { listWorkspaces } from "@/server/workspaces";
import { builtinSkill, isBuiltinSkillKey, type BuiltinSkillKey } from "@/lib/builtin-skills";
import { describeSkill, MAX_SKILL_DESCRIPTION, skillNames, skillSlug } from "@/lib/skills";

export { MAX_SKILL_DESCRIPTION } from "@/lib/skills";

export type SkillErrorCode = "notAPage" | "notADatabase" | "template" | "inTrash" | "tooLong" | "notASkill";

/** The icon a new skills database gets. */
const SKILL_DATABASE_ICON = "🪄";

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
 * other settings; templates (and pages in them) and databases can't be skills. A row of a skills
 * database keeps its description in the database's description property: that is written instead.
 */
export async function setSkill(userId: string, pageId: string, change: { skill?: boolean; description?: string }) {
  const found = await requirePageAccess(userId, pageId, "edit");
  if (found.kind !== "page") throw new SkillError("notAPage", "Only pages and database rows can be skills, not databases");
  if (found.isTemplate || found.inTemplate) throw new SkillError("template", "Templates and the pages in them can't be skills");
  if (found.archivedAt) throw new SkillError("inTrash", "Restore the page from the trash first");
  let description = change.description === undefined ? undefined : change.description.trim();
  if (description !== undefined && description.length > MAX_SKILL_DESCRIPTION) {
    throw new SkillError("tooLong", `A skill's description may have at most ${MAX_SKILL_DESCRIPTION} characters`);
  }
  if (description !== undefined && found.parentId) {
    const property = await descriptionProperty(found.parentId);
    if (property) {
      // The trigger copies the value into skill_description (drizzle/0113_skills_database.sql).
      await updateRowProperties(userId, pageId, { [property]: description || null });
      description = undefined;
    }
  }
  const set: Partial<typeof page.$inferInsert> = {};
  if (change.skill !== undefined) set.isSkill = change.skill;
  if (description !== undefined) set.skillDescription = description;
  if (Object.keys(set).length) await db.update(page).set(set).where(eq(page.id, pageId));
  const collab = getCollab();
  // Open tabs of the page and its database's views refetch the header.
  collab.broadcast(`page:${pageId}`, PAGE_HEADER_EVENT);
  if (found.parentId) collab.broadcast(`db:${found.parentId}`, "rows");
}

/** The text property a skills database keeps its rows' descriptions in, while it is one and the property is there. */
async function descriptionProperty(databaseId: string): Promise<string | null> {
  return (await skillDescriptionProperty(databaseId))?.id ?? null;
}

/**
 * The property a skills database keeps its rows' descriptions in (see descriptionProperty), with
 * its name, for the skill bar of a row; null for other databases.
 */
export async function skillDescriptionProperty(databaseId: string): Promise<{ id: string; name: string } | null> {
  const [found] = await db
    .select({ id: databaseProperty.id, name: databaseProperty.name })
    .from(page)
    .innerJoin(
      databaseProperty,
      and(
        eq(databaseProperty.id, page.skillDescriptionProperty),
        eq(databaseProperty.databaseId, page.id),
        eq(databaseProperty.type, "text"),
        isNull(databaseProperty.deletedAt),
      ),
    )
    .where(and(eq(page.id, databaseId), eq(page.isSkillDatabase, true)));
  return found ?? null;
}

/** The names a new skills database's title, properties and view get, in the person's language. */
async function skillDatabaseNames(locale?: string) {
  const messages = await loadMessages(isLocale(locale) ? locale : DEFAULT_LOCALE);
  return { ...messages.skills.database, table: messages.database.views.table };
}

/**
 * Turns a database into a skills database, or back. Its rows become skills (or stop being ones),
 * and so does every row added later; their descriptions come from a text property, the one named
 * like a skills database's description property in the person's language, added when there's
 * none. Needs full access, like the database's other settings.
 */
export async function setSkillDatabase(userId: string, databaseId: string, on: boolean, locale?: string) {
  const found = await requirePageAccess(userId, databaseId, "full");
  if (found.kind !== "database") throw new SkillError("notADatabase", "Only databases can be skills databases");
  if (found.isTemplate || found.inTemplate) throw new SkillError("template", "Templates and the pages in them can't be skills");
  if (found.archivedAt) throw new SkillError("inTrash", "Restore the page from the trash first");
  if (on) {
    let property = (await descriptionPropertyOf(databaseId, found.skillDescriptionProperty)) ?? null;
    if (!property) {
      const names = await skillDatabaseNames(locale);
      const [named] = await db
        .select({ id: databaseProperty.id })
        .from(databaseProperty)
        .where(
          and(
            eq(databaseProperty.databaseId, databaseId),
            eq(databaseProperty.type, "text"),
            isNull(databaseProperty.deletedAt),
            sql`lower(${databaseProperty.name}) = lower(${names.description})`,
          ),
        )
        .orderBy(databaseProperty.position)
        .limit(1);
      property =
        named?.id ??
        (
          await db
            .insert(databaseProperty)
            .values({ databaseId, name: names.description, type: "text", position: await nextPosition(databaseId) })
            .returning({ id: databaseProperty.id })
        )[0].id;
    }
    // Raw SQL: no updated_at stamps on the rows. Touching properties runs the trigger, which
    // copies each row's description.
    await db.execute(sql`update page set is_skill_database = true, skill_description_property = ${property} where id = ${databaseId}`);
    await db.execute(sql`update page set is_skill = true, properties = properties where parent_id = ${databaseId} and kind = 'page'`);
  } else {
    await db.execute(sql`update page set is_skill_database = false where id = ${databaseId}`);
    await db.execute(sql`update page set is_skill = false where parent_id = ${databaseId} and kind = 'page'`);
  }
  const collab = getCollab();
  collab.broadcast(`page:${databaseId}`, PAGE_HEADER_EVENT);
  collab.broadcast(`db:${databaseId}`, "schema");
  collab.broadcast(`db:${databaseId}`, "rows");
}

/** The database's description property when `id` names one of its text properties that is there. */
async function descriptionPropertyOf(databaseId: string, id: string | null) {
  if (!id) return null;
  const [found] = await db
    .select({ id: databaseProperty.id })
    .from(databaseProperty)
    .where(
      and(
        eq(databaseProperty.id, id),
        eq(databaseProperty.databaseId, databaseId),
        eq(databaseProperty.type, "text"),
        isNull(databaseProperty.deletedAt),
      ),
    );
  return found?.id ?? null;
}

async function nextPosition(databaseId: string) {
  const [last] = await db
    .select({ position: sql<number>`coalesce(max(${databaseProperty.position}), 0)` })
    .from(databaseProperty)
    .where(eq(databaseProperty.databaseId, databaseId));
  return Number(last?.position ?? 0) + 1;
}

/**
 * The skills database new skills of the person go to: one of the workspace's they may add rows
 * to, their own first, then the oldest; null when there's none.
 */
export async function findSkillDatabase(userId: string, workspaceId: string): Promise<{ id: string; title: string } | null> {
  const [found] = await db
    .select({ id: page.id, title: page.title })
    .from(page)
    .where(
      and(
        eq(page.workspaceId, workspaceId),
        eq(page.isSkillDatabase, true),
        eq(page.kind, "database"),
        isNull(page.archivedAt),
        eq(page.inTemplate, false),
        sql`page_access_level(${userId}, ${page.id}) >= ${EDIT_RANK}`,
      ),
    )
    .orderBy(sql`${page.createdBy} is distinct from ${userId}`, page.createdAt)
    .limit(1);
  return found ?? null;
}

/**
 * The person's skills database (findSkillDatabase), or a new private one at the top of the
 * workspace (which needs leave to add pages there) with a description, files, tags and who made
 * each skill.
 */
export async function skillDatabaseFor(userId: string, workspaceId: string, locale?: string): Promise<string> {
  const found = await findSkillDatabase(userId, workspaceId);
  if (found) return found.id;
  const names = await skillDatabaseNames(locale);
  const created = await createPage(
    { userId },
    {
      workspaceId,
      teamspaceId: null,
      kind: "database",
      title: names.title,
      icon: SKILL_DATABASE_ICON,
      seedProperties: false,
      seedNames: { ...ENGLISH_SEED_NAMES, table: names.table },
    },
  );
  const [description] = await db
    .insert(databaseProperty)
    .values([
      { databaseId: created.id, name: names.description, type: "text", position: 1 },
      { databaseId: created.id, name: names.files, type: "files", position: 2 },
      { databaseId: created.id, name: names.tags, type: "multi_select", position: 3, options: { options: [] } },
      { databaseId: created.id, name: names.createdBy, type: "created_by", position: 4 },
    ])
    .returning({ id: databaseProperty.id });
  await db.execute(sql`update page set is_skill_database = true, skill_description_property = ${description.id} where id = ${created.id}`);
  getCollab().broadcast(`ws:${workspaceId}`, "tree");
  return created.id;
}

/**
 * A new skill: a row of the person's skills database (skillDatabaseFor), which the trigger marks
 * as a skill, with the description in its description property.
 */
export async function createSkill(
  userId: string,
  workspaceId: string,
  input: { title?: string; icon?: string | null; markdown?: string; description?: string } = {},
  locale?: string,
): Promise<{ id: string; workspaceId: string; databaseId: string }> {
  const databaseId = await skillDatabaseFor(userId, workspaceId, locale);
  const property = await descriptionProperty(databaseId);
  const description = input.description?.trim().slice(0, MAX_SKILL_DESCRIPTION);
  const created = await createPage(
    { userId },
    {
      workspaceId,
      parentId: databaseId,
      title: input.title,
      icon: input.icon,
      markdown: input.markdown,
      properties: property && description ? { [property]: description } : undefined,
    },
  );
  return { id: created.id, workspaceId: created.workspaceId, databaseId };
}

/**
 * A new skill from a built-in one (lib/builtin-skills), in the person's language, with the
 * built-in's description, in their skills database; from then on it is theirs to change and share.
 */
export async function createBuiltinSkill(
  userId: string,
  workspaceId: string,
  key: BuiltinSkillKey,
  locale?: string,
): Promise<{ id: string; workspaceId: string; databaseId: string }> {
  if (!isBuiltinSkillKey(key)) throw new Error(`Unknown built-in skill "${String(key)}"`);
  const builtin = await builtinSkill(key, locale);
  return createSkill(
    userId,
    workspaceId,
    { title: builtin.title, icon: builtin.icon, markdown: builtin.markdown, description: builtin.description },
    locale,
  );
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
