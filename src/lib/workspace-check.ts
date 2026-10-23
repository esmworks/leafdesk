/**
 * The workspace check (server/workspace-check.ts gathers it, Settings > Health and the MCP tool
 * check_workspace show it): what is worth tidying among the pages someone can open. Links to pages
 * in the trash or deleted, pages nothing leads to, pages with a title and no body, pages nobody
 * edited for months, pages whose verification ended, pages that say nearly the same thing, and
 * relations to rows in the trash or deleted. Everything here is plain data and pure functions, shared by the server and the browser.
 */

export type CheckPageKind = "page" | "database" | "row";

/** A page a finding is about, as the person sees it. */
export type CheckPage = {
  id: string;
  title: string;
  icon: string | null;
  kind: CheckPageKind;
  /** The person may edit it (and so fix what the finding is about there). */
  canEdit: boolean;
};

/** Where a link or relation goes when it leads nowhere: a page in the trash, or one deleted for good. */
export type DeadTarget =
  | { id: string; status: "trash"; title: string; icon: string | null; canRestore: boolean }
  | { id: string; status: "deleted" };

export type BrokenLink = { source: CheckPage; target: DeadTarget };

/** A page no other page leads to; `linkFrom`: a page that writes its title and could link it. */
export type Orphan = CheckPage & { linkFrom?: { id: string; title: string; icon: string | null } };

export type StalePage = CheckPage & { updatedAt: string };

/** A page whose verification ended (server/verification.ts): who verified it, and when it ended. */
export type ExpiredVerification = CheckPage & { by: string | null; until: string };

export type DuplicatePair = { a: CheckPage; b: CheckPage; similarity: number };

export type BrokenRelation = {
  row: CheckPage;
  database: { id: string; title: string; icon: string | null };
  property: { id: string; name: string };
  target: DeadTarget;
  /** The person may change this property of this row (and so take the dead row out of it). */
  canFix: boolean;
};

/** A list of findings: the first ones and how many there are in all. */
export type CheckSection<T> = { items: T[]; total: number };

/** Why the duplicate check didn't run: the server has no embeddings model, or the workspace has AI off. */
export type DuplicatesSkipped = "noEmbeddings" | "aiOff";

export type DuplicateSection =
  | (CheckSection<DuplicatePair> & { status: "done"; minSimilarity: number; compared: number })
  | { status: "skipped"; reason: DuplicatesSkipped };

export type WorkspaceCheck = {
  workspaceId: string;
  checkedAt: string;
  /** The pages looked at: the ones the person can open (templates and the trash left out). */
  pages: number;
  /** More pages than one check looks at: the ones edited longest ago were left out. */
  truncated: boolean;
  staleMonths: number;
  brokenLinks: CheckSection<BrokenLink>;
  orphans: CheckSection<Orphan>;
  empty: CheckSection<CheckPage>;
  stale: CheckSection<StalePage>;
  expiredVerifications: CheckSection<ExpiredVerification>;
  duplicates: DuplicateSection;
  brokenRelations: CheckSection<BrokenRelation>;
};

export const CHECK_SECTIONS = ["brokenLinks", "orphans", "empty", "stale", "expiredVerifications", "duplicates", "brokenRelations"] as const;
export type CheckSectionKey = (typeof CHECK_SECTIONS)[number];

/** Pages one check looks at at most; past this the ones edited longest ago are left out. */
export const MAX_CHECKED_PAGES = 5000;
/** Findings of each kind a report lists (the total counts them all). */
export const MAX_FINDINGS = 100;
/** Pages compared for duplicates at most, the most recently edited first (every pair is compared). */
export const MAX_DUPLICATE_PAGES = 1000;
/** Orphans for which a page writing their title is looked for. */
export const MAX_LINK_SUGGESTIONS = 25;

export const STALE_MONTHS = [3, 6, 12, 24] as const;
export const DEFAULT_STALE_MONTHS = 6;
/** How alike two pages' meaning must be (cosine of their mean embeddings) to be offered as duplicates. */
export const DEFAULT_DUPLICATE_SIMILARITY = 0.92;
export const MIN_DUPLICATE_SIMILARITY = 0.8;

/** The stale period a query asks for, one of STALE_MONTHS, DEFAULT_STALE_MONTHS otherwise. */
export function parseStaleMonths(value: unknown): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return (STALE_MONTHS as readonly number[]).includes(n) ? n : DEFAULT_STALE_MONTHS;
}

/** The instant `months` calendar months before `now`: pages last edited before it are stale. */
export function staleCutoff(now: Date, months: number): Date {
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff;
}

/** The first MAX_FINDINGS of `items`, with how many there are. */
export function section<T>(items: T[], max = MAX_FINDINGS): CheckSection<T> {
  return { items: items.slice(0, max), total: items.length };
}

/** A page as the check sees it, before it is sorted into findings. */
export type CheckedPage = {
  id: string;
  title: string;
  kind: CheckPageKind;
  /** No parent: the page sits at the top of the sidebar (or of a teamspace). */
  topLevel: boolean;
  /** It has pages (or rows) inside it, whoever can open them. */
  hasChildren: boolean;
  /** A page the person can open leads to it: a link or mention in its body, or a relation. */
  linkedTo: boolean;
  /** Nothing in its body: no text, no image, no block of any kind. */
  emptyBody: boolean;
  isSkill: boolean;
  updatedAt: Date;
};

/**
 * Pages nothing leads to: at the top level, with nothing inside them and no page linking to them.
 * Databases and skills are reached their own ways (the database's views, the skills library) and
 * aren't counted, and neither are pages with no body: there is nothing to link to yet (with a title,
 * they are listed as empty).
 */
export function isOrphan(p: CheckedPage): boolean {
  return p.kind === "page" && p.topLevel && !p.hasChildren && !p.linkedTo && !p.isSkill && !p.emptyBody;
}

/**
 * Pages that have a title and nothing else: no body and no pages inside. Database rows aren't
 * counted (most rows hold only their values), nor are pages without a title (a page just started).
 */
export function isEmptyPage(p: CheckedPage): boolean {
  return p.kind === "page" && p.emptyBody && !p.hasChildren && p.title.trim() !== "";
}

/** Pages (not databases or rows, whose edits are their rows' and values') nobody edited since `cutoff`. */
export function isStale(p: CheckedPage, cutoff: Date): boolean {
  return p.kind === "page" && p.updatedAt.getTime() < cutoff.getTime();
}

/**
 * Pairs of `vectors` whose cosine similarity is at least `min`, most alike first. Vectors of
 * another length than the first, or all zeros, are left out. Every pair is compared, so the caller
 * keeps the list to MAX_DUPLICATE_PAGES.
 */
export function similarPairs(
  vectors: { id: string; vector: ArrayLike<number> }[],
  min: number,
): { a: string; b: string; similarity: number }[] {
  const size = vectors[0]?.vector.length ?? 0;
  const unit: { id: string; v: Float64Array }[] = [];
  for (const { id, vector } of vectors) {
    if (vector.length !== size || !size) continue;
    let norm = 0;
    for (let i = 0; i < size; i++) norm += vector[i] * vector[i];
    if (!norm) continue;
    const scale = 1 / Math.sqrt(norm);
    const v = new Float64Array(size);
    for (let i = 0; i < size; i++) v[i] = vector[i] * scale;
    unit.push({ id, v });
  }
  const out: { a: string; b: string; similarity: number }[] = [];
  for (let i = 0; i < unit.length; i++) {
    const x = unit[i].v;
    for (let j = i + 1; j < unit.length; j++) {
      const y = unit[j].v;
      let dot = 0;
      for (let k = 0; k < size; k++) dot += x[k] * y[k];
      if (dot >= min) out.push({ a: unit[i].id, b: unit[j].id, similarity: Math.min(1, dot) });
    }
  }
  return out.sort((p, q) => q.similarity - p.similarity || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
}

/** How many findings the report has, all kinds together (duplicates only when that check ran). */
export function findingCount(check: WorkspaceCheck): number {
  return (
    check.brokenLinks.total +
    check.orphans.total +
    check.empty.total +
    check.stale.total +
    check.expiredVerifications.total +
    (check.duplicates.status === "done" ? check.duplicates.total : 0) +
    check.brokenRelations.total
  );
}
