/**
 * Build with AI: someone describes what they need ("a hiring pipeline with candidates, interviews
 * and an offer stage") and the AI drafts a plan of databases (lib/ai-build): typed properties with
 * their options, relations between them, a few views, example rows and an intro page. Nothing is
 * saved by drafting (`draftDatabasePlan`): the person sees the plan, changes what they like, and
 * creating it (`createFromPlan`) makes it as they left it, as them, in the place they chose. The AI
 * chat's create_databases change creates a plan its model wrote the same way.
 *
 * Drafting counts as AI usage ("build.plan") and is held to the workspace's AI limits like any
 * other request; a plan that doesn't pass the check is sent back to the model once, with what is
 * wrong, before the person hears it didn't work.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { databaseView } from "@/db/schema";
import type { ViewConfig } from "@/db/schema/app";
import { readDraftJson } from "@/lib/agent-draft";
import { MAX_BUILD_REQUEST, validateDatabasePlan, type DatabasePlan, type PlanViewType } from "@/lib/ai-build";
import { DEFAULT_VIEW_NAMES } from "@/lib/views";
import { loadMessages } from "@/i18n/messages";
import { AccessError, requireMembership, requirePageAccess } from "@/server/access";
import { AiError, complete, type AiMessage } from "@/server/ai";
import { buildPlanPrompt, buildPlanRepair } from "@/server/ai/prompts";
import { aiAvailable } from "@/server/ai-writing";
import { recordAudit } from "@/server/audit";
import { addProperty, addView, createRows, getLookups, getProperties, updateRowProperties } from "@/server/databases";
import { discard } from "@/server/import/markdown";
import { savedLocale } from "@/server/mail/locale";
import { toFilterEntries, toSortRule } from "@/server/mcp/query";
import { createPage, savedSeedNames } from "@/server/pages";

/**
 * Why a plan can't be drafted or created: `unusable` when the AI's answers held no plan that
 * passes, `invalid` for a plan sent to be created that doesn't (with what is wrong), `parent` when
 * the place is a database (rows go there, not databases).
 */
export class BuildError extends Error {
  constructor(
    readonly code: "unusable" | "invalid" | "parent",
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "BuildError";
  }
}

/**
 * A plan of databases for what `request` says, checked (validateDatabasePlan) and not saved. Throws
 * AiError when the workspace has no AI or the request fails, BuildError("unusable") when the AI's
 * plan still doesn't pass after it was told what is wrong.
 */
export async function draftDatabasePlan(
  userId: string,
  workspaceId: string,
  request: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DatabasePlan> {
  await requireMembership(userId, workspaceId);
  const text = typeof request === "string" ? request.trim().slice(0, MAX_BUILD_REQUEST) : "";
  if (!text) throw new AiError("invalid", "Describe what you need");
  if (!(await aiAvailable(workspaceId))) throw new AiError("disabled", "AI is off for this workspace");
  const prompt = buildPlanPrompt(text);
  const messages: AiMessage[] = [{ role: "user", content: prompt.prompt }];
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await complete({ feature: "build.plan", userId, workspaceId, system: prompt.system, messages, signal, skipRateLimit: attempt > 0 });
    const checked = result.stopReason === "length" ? null : validateDatabasePlan(readDraftJson(result.text));
    if (checked?.ok) return checked.plan;
    problems = checked ? checked.problems : ["The answer was cut off: make the plan smaller."];
    messages.push(result.message, { role: "user", content: buildPlanRepair(problems) });
  }
  throw new BuildError("unusable", "The AI's plan couldn't be used", problems);
}

/** Where a plan goes: under a page, or at the top of the workspace (a teamspace, null for private, undefined for the default one). */
export type BuildPlace = { parentId: string } | { teamspaceId?: string | null };

export type BuildResult = {
  /** The page to open: the intro page, else the first database. */
  rootId: string;
  databases: { id: string; title: string }[];
};

/** View names in the person's language, for views the plan leaves unnamed. */
async function viewNames(userId: string): Promise<Record<PlanViewType, string>> {
  const locale = await savedLocale(userId);
  if (!locale) return DEFAULT_VIEW_NAMES;
  return (await loadMessages(locale)).database.views;
}

/**
 * Creates a plan as `userId`, in `workspaceId` at `place`: the intro page with the databases under
 * it (or the databases there on their own), their properties, relations, views and example rows.
 * The plan is checked again first, since the person may have changed it. Every step is checked as
 * it would be on its own (edit access to the place, values a row may hold); when one fails, what
 * was made is deleted again and the error goes to the caller. Throws BuildError("invalid") for a
 * plan that doesn't pass, AccessError, PropertyValueError.
 */
export async function createFromPlan(userId: string, workspaceId: string, raw: unknown, place: BuildPlace): Promise<BuildResult> {
  const checked = validateDatabasePlan(raw);
  if (!checked.ok) throw new BuildError("invalid", "The plan can't be created as it is", checked.problems);
  const plan = checked.plan;
  const actor = { userId };
  let base: { parentId: string } | { teamspaceId?: string | null };
  if ("parentId" in place && place.parentId) {
    const parent = await requirePageAccess(userId, place.parentId, "edit");
    if (parent.workspaceId !== workspaceId) throw new AccessError();
    if (parent.kind === "database") throw new BuildError("parent", "Databases can't go inside a database");
    base = { parentId: parent.id };
  } else {
    await requireMembership(userId, workspaceId);
    base = { teamspaceId: "teamspaceId" in place ? place.teamspaceId : undefined };
  }
  const [names, views] = await Promise.all([savedSeedNames(userId), viewNames(userId)]);

  // Recorded once it all went through, as imports are: a plan taken back leaves no trace.
  const roots: { id: string; title: string; kind: "page" | "database" }[] = [];
  const ids = new Map<string, string>();
  try {
    let under = base;
    if (plan.intro) {
      const intro = await createPage(actor, { workspaceId, ...base, title: plan.intro.title, icon: plan.intro.icon, markdown: plan.intro.markdown }, { audit: false });
      roots.push({ id: intro.id, title: intro.title, kind: "page" });
      under = { parentId: intro.id };
    }
    for (const database of plan.databases) {
      const created = await createPage(
        actor,
        { workspaceId, ...under, kind: "database", title: database.title, icon: database.icon, seedNames: names, seedProperties: false },
        { audit: false },
      );
      ids.set(database.key, created.id);
      if (!plan.intro) roots.push({ id: created.id, title: created.title, kind: "database" });
    }

    // Properties, then relations (their databases exist by now), then views over all of them.
    for (const database of plan.databases) {
      const databaseId = ids.get(database.key)!;
      for (const p of database.properties) {
        if (p.type === "relation") continue;
        const options =
          p.type === "status" && !p.options?.length
            ? [names.notStarted, names.inProgress, names.done]
            : p.options?.map((o) => ({ name: o.name, color: o.color, ...(o.group ? { group: o.group } : {}) }));
        await addProperty(userId, databaseId, { name: p.name, type: p.type, options, ...(p.description ? { description: p.description } : {}) });
      }
    }
    for (const database of plan.databases) {
      for (const p of database.properties) {
        if (p.type !== "relation") continue;
        await addProperty(userId, ids.get(database.key)!, {
          name: p.name,
          type: "relation",
          relation: { databaseId: ids.get(p.database!)!, twoWay: p.two_way, pairedName: p.paired_name },
          ...(p.description ? { description: p.description } : {}),
        });
      }
    }
    for (const database of plan.databases) {
      const databaseId = ids.get(database.key)!;
      const properties = await getProperties(databaseId);
      const lookups = await getLookups(userId, properties);
      const id = (name: string | undefined) => properties.find((p) => name !== undefined && p.name.trim().toLowerCase() === name.trim().toLowerCase())?.id;
      // The table a new database starts with makes way for the plan's views.
      const [starter] = await db.select({ id: databaseView.id }).from(databaseView).where(eq(databaseView.databaseId, databaseId));
      for (const view of database.views) {
        const config: ViewConfig = {};
        if (view.group_by) config.groupBy = id(view.group_by);
        if (view.date_by) config.dateBy = id(view.date_by);
        if (view.filters?.length) config.filters = toFilterEntries(properties, view.filters, lookups);
        if (view.sorts?.length) config.sorts = view.sorts.map((s) => toSortRule(properties, s));
        await addView(userId, databaseId, { name: view.name || views[view.type], type: view.type, config });
      }
      if (starter) await db.delete(databaseView).where(eq(databaseView.id, starter.id));
    }

    // Example rows, then the links between them (the rows they link to exist by then).
    const rowIds = new Map<string, Map<string, string>>();
    for (const database of plan.databases) {
      if (!database.rows.length) continue;
      const relations = new Set(database.properties.filter((p) => p.type === "relation").map((p) => p.name.toLowerCase()));
      const made = await createRows(
        userId,
        ids.get(database.key)!,
        database.rows.map((row) => ({
          title: row.title,
          properties: Object.fromEntries(Object.entries(row.values).filter(([name]) => !relations.has(name.toLowerCase()))),
        })),
      );
      rowIds.set(database.key, new Map(made.map((r) => [r.title.trim().toLowerCase(), r.id])));
    }
    for (const database of plan.databases) {
      const made = rowIds.get(database.key);
      for (const row of database.rows) {
        const links: Record<string, string[]> = {};
        for (const p of database.properties) {
          const titles = row.values[p.name];
          if (p.type !== "relation" || !Array.isArray(titles)) continue;
          const linked = rowIds.get(p.database!);
          links[p.name] = titles.flatMap((t) => linked?.get(String(t).trim().toLowerCase()) ?? []);
        }
        const rowId = made?.get(row.title.trim().toLowerCase());
        if (rowId && Object.keys(links).length) await updateRowProperties(userId, rowId, links);
      }
    }
  } catch (error) {
    await discard(workspaceId, roots);
    throw error;
  }
  for (const root of roots) {
    await recordAudit({ workspaceId, actorId: userId, action: "page.created", target: { type: "page", id: root.id, label: root.title }, details: { kind: root.kind } });
  }
  return { rootId: roots[0].id, databases: plan.databases.map((d) => ({ id: ids.get(d.key)!, title: d.title })) };
}
