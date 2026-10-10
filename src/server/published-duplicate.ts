import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import * as Y from "yjs";
import { db } from "@/db";
import { databaseProperty, databaseView, file, page, type PageKind, type RowProperties } from "@/db/schema";
import { blocksToPlainText } from "@/lib/blocks";
import { COLLAB_FRAGMENT } from "@/lib/collab-constants";
import { writeDocTitle } from "@/lib/collab-title";
import { copyAccess, dropPropertyReferences, planDuplicate, redactCopy, type CopyAccess, type SourcePage } from "@/lib/duplicate";
import { fileIdsIn, fileIdsInProperties } from "@/lib/files";
import { parsePageBackground } from "@/lib/page-background";
import { UNPUBLISHED_PROPERTY_TYPES } from "@/lib/property-types";
import { copyPublishedBlocks, mentionedPageIds, remapFilePaths } from "@/lib/published-copy";
import { SlidingWindowLimiter, takeAll } from "@/lib/rate-limit";
import { publishedHref, type PublishedLinks } from "@/lib/site";
import { stripComments } from "@/lib/strip-comments";
import { pageVisibleTo } from "@/server/access";
import { recordAudit } from "@/server/audit";
import { blocksToMarkdown, serverEditor, type PageBlock } from "@/server/blocknote";
import { getCollab, type WriteActor } from "@/server/collab/bridge";
import { workspaceFiles, workspaceUsage } from "@/server/files";
import { publishedPageRefs, syncPageReferences } from "@/server/mentions";
import { makePagePrivate } from "@/server/permissions";
import { chainTo, readableViews, readerAccess, webViews } from "@/server/publication";
import { servedPublication } from "@/server/site";
import { getStorage, uploadLimits } from "@/server/storage";
import { topLevelAccess } from "@/server/workspaces";

/**
 * "Duplicate" on a published page: a signed-in visitor copies the page, as it is published, to the
 * top of a workspace where they may add pages (optionally as a template of that workspace).
 *
 * Only what the publication shows is copied: the page and the live subpages and rows its publisher
 * can see, outside templates; databases with their public properties (no relations, rollups or
 * people, nor what property access keeps from anonymous visitors) and the views on the web. Bodies are rebuilt from their blocks (lib/published-copy.ts),
 * so no edit history, comments, people's ids or reminders come along. Uploaded files the pages show
 * are copied into the new workspace, within its storage quota. Nothing is written until everything
 * is ready, and then in one transaction.
 *
 * The publication must allow it (`allowDuplicate`, off by default), and each user may duplicate a
 * few pages a minute and a few dozen an hour.
 */

/** Largest published subtree one duplicate copies. */
export const MAX_PUBLISHED_COPY_PAGES = 500;
/** Most files one duplicate copies. */
const MAX_COPY_FILES = 200;

const perMinute = new SlidingWindowLimiter(5, 60_000);
const perHour = new SlidingWindowLimiter(30, 60 * 60_000);

export class DuplicateError extends Error {
  constructor(
    message: string,
    readonly code: "notFound" | "notAllowed" | "noAccess" | "rateLimited" | "tooLarge" | "quotaExceeded",
  ) {
    super(message);
    this.name = "DuplicateError";
  }
}

/** Starts the limits over (tests). */
export function resetDuplicateLimits() {
  perMinute.reset();
  perHour.reset();
}

type SourceRow = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  kind: PageKind;
  title: string;
  icon: string | null;
  background: unknown;
  position: number;
  properties: RowProperties;
  ydoc: Uint8Array | Buffer | null;
};

/** Labels for pages a copy mentions but doesn't carry, in the visitor's language. */
async function mentionLabels() {
  try {
    const [t, tc] = await Promise.all([getTranslations("page.mention"), getTranslations("common")]);
    return { untitled: tc("untitled"), private: t("noAccess"), deleted: t("deleted") };
  } catch {
    return { untitled: "Untitled", private: "No access", deleted: "Deleted page" };
  }
}

/**
 * Copies the page `pageId` (the root without it) behind the public address `key` (a publication
 * token or a site slug) into `workspaceId`. Returns the copy.
 */
export async function duplicatePublishedPage(
  actor: WriteActor,
  input: { key: string; pageId?: string; workspaceId: string; asTemplate?: boolean },
): Promise<{ workspaceId: string; pageId: string }> {
  const { userId } = actor;
  const served = await servedPublication(input.key, input.pageId);
  if (!served) throw new DuplicateError("This page isn't published", "notFound");
  if (!served.allowDuplicate) throw new DuplicateError("This page can't be duplicated", "notAllowed");
  const target = input.workspaceId;
  const topLevel = await topLevelAccess(userId, target);
  if (!topLevel) throw new DuplicateError("You can't add pages to that workspace", "noAccess");
  if (takeAll([[perMinute, userId], [perHour, userId]]) > 0) throw new DuplicateError("Too many duplicates; try again later", "rateLimited");
  const { publisher } = served;

  // What the publication shows under the page: live pages the publisher can see, outside templates.
  const rows = [
    ...(await db.execute<SourceRow>(sql`
      with recursive sub as (
        select id from ${page} where id = ${served.pageId}
        union all
        select p.id from ${page} p join sub on p.parent_id = sub.id
        where p.archived_at is null and not p.in_template and ${pageVisibleTo(publisher, "p")}
      )
      select p.id, p.workspace_id, p.parent_id, p.kind, p.title, p.icon, p.background, p.position, p.properties, p.ydoc
      from (select id from sub limit ${MAX_PUBLISHED_COPY_PAGES + 1}) s
      join ${page} p on p.id = s.id
    `)),
  ];
  if (rows.length > MAX_PUBLISHED_COPY_PAGES) {
    throw new DuplicateError(`Can't duplicate more than ${MAX_PUBLISHED_COPY_PAGES} pages at once`, "tooLarge");
  }
  const root = rows.find((r) => r.id === served.pageId);
  if (!root) throw new DuplicateError("This page isn't published", "notFound");
  const sourceWorkspace = root.workspace_id;

  // Databases: their public properties, and the views the web shows.
  const databaseIds = rows.filter((r) => r.kind === "database").map((r) => r.id);
  const allProperties = databaseIds.length
    ? await db.select().from(databaseProperty).where(inArray(databaseProperty.databaseId, databaseIds))
    : [];
  const properties = allProperties.filter((p) => !UNPUBLISHED_PROPERTY_TYPES.has(p.type));
  const dropped = new Set(allProperties.filter((p) => UNPUBLISHED_PROPERTY_TYPES.has(p.type)).map((p) => p.id));
  const views = (await Promise.all(databaseIds.map(async (id) => webViews(await readableViews(id))))).flat();
  // Property access: the copy holds what anonymous visitors see (publication readerAccess), not
  // what the publisher or the person copying may: no property whose level for everyone is `none`
  // and no value of one below `view`. No rules come along: the copy lands in another workspace.
  const carried = new Map<string, CopyAccess>();
  for (const id of databaseIds) {
    const own = allProperties.filter((p) => p.databaseId === id);
    const { access, gone } = await readerAccess(null, id, own);
    const kept = copyAccess(access, own, { gone });
    if (kept) carried.set(id, kept);
  }

  const [top] = await db
    .select({ max: sql<number | null>`max(${page.position})` })
    .from(page)
    .where(and(eq(page.workspaceId, target), isNull(page.parentId)));
  const plan = planDuplicate(
    redactCopy(
      {
        rootId: root.id,
        pages: rows.map(
          (r): SourcePage => ({ id: r.id, parentId: r.parent_id, kind: r.kind, title: r.title, position: Number(r.position), properties: r.properties }),
        ),
        properties,
        views: views.map((v) => ({ ...v, config: dropPropertyReferences(v.config, (id) => dropped.has(id)) })),
        rootTitle: root.title,
        rootPosition: (Number(top?.max) || 0) + 1,
      },
      carried,
    ),
  );
  const keptProperties = new Set(plan.properties.map((p) => p.id));
  const copiedDatabases = new Set(plan.pages.filter((p) => p.kind === "database").map((p) => p.id));
  const sources = new Map(rows.map((r) => [r.id, r]));

  // Row values of copied databases, without the properties left behind; other pages hold none.
  const values = new Map(
    plan.pages.map((p) => [
      p.id,
      p.id !== plan.rootId && p.parentId && copiedDatabases.has(p.parentId)
        ? Object.fromEntries(Object.entries(p.properties).filter(([key]) => keptProperties.has(key)))
        : {},
    ]),
  );

  // Bodies as blocks, and the uploaded files the copy shows.
  const blocksOf = new Map<string, PageBlock[]>();
  for (const p of plan.pages) {
    const ydoc = sources.get(p.sourceId)?.ydoc;
    if (!ydoc?.byteLength) continue;
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, ydoc instanceof Uint8Array ? ydoc : new Uint8Array(ydoc));
      blocksOf.set(p.id, serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT)));
    } finally {
      doc.destroy();
    }
  }
  const fileIds = new Set<string>();
  const firstShownOn = new Map<string, string>();
  for (const p of plan.pages) {
    const ids = [...fileIdsIn(JSON.stringify(blocksOf.get(p.id) ?? [])), ...fileIdsInProperties(values.get(p.id))];
    for (const id of ids) {
      fileIds.add(id);
      if (!firstShownOn.has(id)) firstShownOn.set(id, p.id);
    }
  }
  const files = await workspaceFiles(sourceWorkspace, [...fileIds]);
  if (files.length > MAX_COPY_FILES) throw new DuplicateError(`Can't copy more than ${MAX_COPY_FILES} files at once`, "tooLarge");
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  const { workspaceQuotaBytes } = uploadLimits();
  if (bytes > workspaceQuotaBytes - (await workspaceUsage(target))) {
    throw new DuplicateError("That workspace doesn't have room for the page's files", "quotaExceeded");
  }

  // Pages the copy mentions but doesn't carry read as the published page shows them.
  const links: PublishedLinks = served.links;
  const outsideIds = [...new Set([...blocksOf.values()].flatMap((blocks) => mentionedPageIds(blocks)))].filter(
    (id) => !plan.pageIds.has(id),
  );
  const outside = outsideIds.length
    ? await publishedPageRefs(publisher, outsideIds, {
        inPublication: async (id, title) =>
          (await chainTo(publisher, id, served.rootId)) || (await served.elsewhere(id)) ? publishedHref(links, id, title) : null,
        labels: await mentionLabels(),
      })
    : new Map<string, { text: string; href: string | null }>();

  // The files' bytes, under new keys of the new workspace. Removed again if anything fails.
  const storage = getStorage();
  const copiedFiles: { id: string; storageKey: string; source: (typeof files)[number] }[] = [];
  const fileMap = new Map<string, string>();
  try {
    for (const source of files) {
      const body = await storage.get(source.storageKey);
      if (!body) continue;
      const id = randomBytes(18).toString("base64url");
      const storageKey = `${target}/${id}`;
      copiedFiles.push({ id, storageKey, source });
      await storage.put(storageKey, Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>), {
        size: source.size,
        contentType: source.contentType,
      });
      fileMap.set(source.id, id);
    }

    // New documents, and their Markdown and text.
    const bodies = new Map<string, { ydoc: Uint8Array; markdown: string; text: string; blocks: PageBlock[] }>();
    for (const p of plan.pages) {
      const blocks = blocksOf.get(p.id);
      if (!blocks) continue;
      const copied = copyPublishedBlocks(blocks, { pageIds: plan.pageIds, fileIds: fileMap, outside });
      const doc = new Y.Doc();
      try {
        writeDocTitle(doc, p.title);
        doc.transact(() => serverEditor.blocksToYXmlFragment(copied, doc.getXmlFragment(COLLAB_FRAGMENT)));
        stripComments(doc);
        const stored = serverEditor.yXmlFragmentToBlocks(doc.getXmlFragment(COLLAB_FRAGMENT));
        bodies.set(p.id, {
          ydoc: Y.encodeStateAsUpdate(doc),
          markdown: (await blocksToMarkdown(stored, { workspaceId: target })).trim(),
          text: blocksToPlainText(stored),
          blocks: stored,
        });
      } finally {
        doc.destroy();
      }
    }

    // Parents before children, so each chunk's parents exist.
    const depth = new Map<string, number>();
    const planned = new Map(plan.pages.map((p) => [p.id, p]));
    const depthOf = (id: string): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      const p = planned.get(id)!;
      const value = id === plan.rootId ? 0 : depthOf(p.parentId!) + 1;
      depth.set(id, value);
      return value;
    };
    const ordered = [...plan.pages].sort((a, b) => depthOf(a.id) - depthOf(b.id));
    const asTemplate = Boolean(input.asTemplate);

    await db.transaction(async (tx) => {
      // The quota again, under the lock uploads take, now that the bytes are stored.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`leafdesk:file-quota:${target}`}))`);
      if (copiedFiles.length) {
        const [used] = await tx
          .select({ used: sql<string>`coalesce(sum(${file.size}), 0)` })
          .from(file)
          .where(eq(file.workspaceId, target));
        const added = copiedFiles.reduce((sum, f) => sum + f.source.size, 0);
        if (Number(used?.used ?? 0) + added > workspaceQuotaBytes) {
          throw new DuplicateError("That workspace doesn't have room for the page's files", "quotaExceeded");
        }
        // Recorded before the pages, so the pages' triggers see them (file_reference).
        await tx.insert(file).values(
          copiedFiles.map(({ id, storageKey, source }) => ({
            id,
            workspaceId: target,
            pageId: null,
            storageKey,
            name: source.name,
            contentType: source.contentType,
            size: source.size,
            uploadedBy: userId,
          })),
        );
      }
      for (let i = 0; i < ordered.length; i += 100) {
        await tx.insert(page).values(
          ordered.slice(i, i + 100).map((p) => {
            const body = bodies.get(p.id);
            const isRoot = p.id === plan.rootId;
            return {
              id: p.id,
              workspaceId: target,
              parentId: isRoot ? null : p.parentId,
              kind: p.kind,
              title: p.title,
              icon: sources.get(p.sourceId)?.icon ?? null,
              background: parsePageBackground(sources.get(p.sourceId)?.background),
              position: p.position,
              properties: JSON.parse(remapFilePaths(JSON.stringify(values.get(p.id) ?? {}), fileMap)) as RowProperties,
              ydoc: body?.ydoc ?? null,
              contentText: body?.text ?? "",
              contentMarkdown: body?.markdown ?? "",
              isTemplate: isRoot && asTemplate,
              inTemplate: asTemplate,
              createdBy: userId,
              updatedBy: userId,
            };
          }),
        );
      }
      for (const { id, source } of copiedFiles) {
        await tx.update(file).set({ pageId: firstShownOn.get(source.id) ?? plan.rootId }).where(eq(file.id, id));
      }
      // A copy from the web lands among their private pages; they move it to a teamspace to share it.
      await makePagePrivate(tx, target, plan.rootId, userId);
      // As a template it is a template's pages, which the audit log leaves out (see createPage).
      if (!asTemplate) {
        await recordAudit(
          {
            workspaceId: target,
            actorId: userId,
            action: "page.duplicated",
            target: { type: "page", id: plan.rootId, label: root.title },
            details: { kind: root.kind, source: root.title, published: true },
          },
          tx,
        );
      }
      if (plan.properties.length) {
        await tx.insert(databaseProperty).values(
          plan.properties.map(({ id, databaseId, name, type, options, position }) => ({ id, databaseId, name, type, options, position })),
        );
      }
      if (plan.views.length) {
        await tx.insert(databaseView).values(
          plan.views.map(({ id, databaseId, name, type, config, position }) => ({ id, databaseId, name, type, config, position })),
        );
      }
    });

    // Links between the copied pages, for backlinks. No people are mentioned any more.
    for (const [id, body] of bodies) {
      if (mentionedPageIds(body.blocks).length) await syncPageReferences(id, target, body.blocks, userId);
    }
  } catch (error) {
    for (const { storageKey } of copiedFiles) {
      await storage.delete(storageKey).catch(() => {});
    }
    throw error;
  }

  getCollab().broadcast(`ws:${target}`, "tree");
  return { workspaceId: target, pageId: plan.rootId };
}

/** Workspaces the user may duplicate a published page into: where they may add top-level pages. */
export async function duplicateTargets(userId: string) {
  const { listWorkspaces } = await import("@/server/workspaces");
  const all = await listWorkspaces(userId);
  const allowed = await Promise.all(all.map(async (w) => ((await topLevelAccess(userId, w.id)) ? w : null)));
  return allowed.filter((w): w is NonNullable<typeof w> => w !== null).map(({ id, name, icon }) => ({ id, name, icon }));
}

