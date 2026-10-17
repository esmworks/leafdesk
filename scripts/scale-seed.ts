/**
 * Fills the database with one large workspace for scripts/scale-e2e.ts: 5,000 pages in a tree
 * three levels deep, each with a few paragraphs, and a database of 50,000 rows with the usual
 * property types (status, select, multi-select, number, date, person, checkbox, text and a
 * formula). Values come from a fixed seed, so every run makes the same workspace. Pages are made
 * through the app's own code with their live documents; rows are written the way bulk imports
 * write them (insertRows, values already checked).
 *
 *   pnpm tsx scripts/scale-seed.ts           # skips when the workspace is already there
 *   pnpm tsx scripts/scale-seed.ts --fresh   # deletes it first
 *
 * Env: DATABASE_URL (read from .env when present), SCALE_PAGES and SCALE_ROWS to change the sizes.
 * Signs in as scale-e2e@example.test with the password in SCALE_PASSWORD below. Migrations must
 * be applied; run it while no app server uses the database (it writes its own live documents).
 */
import { hashPassword } from "better-auth/crypto";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { account, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { createCollab } = await import("@/server/collab/service");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { addProperty, insertRows, getProperties } = await import("@/server/databases");
const { createWorkspace, addMemberAs } = await import("@/server/workspaces");
const { setPagePermission } = await import("@/server/permissions");

// scripts/scale-e2e.ts signs in with the same address and password.
const SCALE = {
  owner: "scale-e2e-owner",
  email: "scale-e2e@example.test",
  password: "scale-e2e-password",
  workspaceName: "Scale test",
  databaseTitle: "Scale tasks",
  pages: Number(process.env.SCALE_PAGES ?? 5_000),
  rows: Number(process.env.SCALE_ROWS ?? 50_000),
};
const PEOPLE = ["Ada", "Bora", "Cem", "Deniz", "Ece"];

const { service } = createCollab();
registerCollab(service);

/** A small fixed-seed generator (mulberry32), so every run writes the same values. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = random(20261017);
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];

const WORDS = (
  "plan budget review launch customer invoice quarter roadmap design meeting notes draft report " +
  "supplier warehouse delivery contract sales service repair compressor install site visit offer " +
  "payment schedule team hiring onboarding release bug fix test metric goal risk owner approval " +
  "summary agenda decision follow up idea research market price quote order stock audit policy"
).split(" ");
const sentence = (words: number) => {
  const parts = Array.from({ length: words }, () => pick(WORDS));
  return parts[0][0].toUpperCase() + parts.join(" ").slice(1) + ".";
};
const paragraph = () => Array.from({ length: 3 + Math.floor(rand() * 4) }, () => sentence(6 + Math.floor(rand() * 10))).join(" ");

async function existing() {
  const [found] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, workspace.id))
    .where(and(eq(workspaceMember.userId, SCALE.owner), eq(workspace.name, SCALE.workspaceName)))
    .limit(1);
  return found?.id ?? null;
}

async function removeAll() {
  const ids = (
    await db
      .select({ id: workspaceMember.workspaceId })
      .from(workspaceMember)
      .where(eq(workspaceMember.userId, SCALE.owner))
  ).map((r) => r.id);
  if (ids.length) await db.delete(workspace).where(inArray(workspace.id, ids));
  await db.delete(user).where(inArray(user.id, [SCALE.owner, ...PEOPLE.map((p) => `scale-e2e-${p.toLowerCase()}`)]));
}

async function seed() {
  const started = Date.now();
  await db.insert(user).values([
    { id: SCALE.owner, name: "Scale Owner", email: SCALE.email, emailVerified: true },
    ...PEOPLE.map((name) => ({ id: `scale-e2e-${name.toLowerCase()}`, name, email: `scale-e2e-${name.toLowerCase()}@example.test`, emailVerified: true })),
  ]);
  await db.insert(account).values({
    id: `${SCALE.owner}-credential`,
    accountId: SCALE.owner,
    providerId: "credential",
    userId: SCALE.owner,
    password: await hashPassword(SCALE.password),
  });
  const { id: workspaceId } = await createWorkspace(SCALE.owner, SCALE.workspaceName);
  for (const name of PEOPLE) await addMemberAs(SCALE.owner, workspaceId, `scale-e2e-${name.toLowerCase()}@example.test`, "member");
  const owner = { userId: SCALE.owner };

  // ---------------------------------------------------------------- pages: 50 × 10 × 9 = 4,500 + 550
  // Each top-level page is filled by its own worker, so siblings never race for a position.
  const top = Math.max(1, Math.round(SCALE.pages / 101));
  let made = 0;
  const body = (title: string) => `## ${title}\n\n${paragraph()}\n\n- ${sentence(5)}\n- ${sentence(7)}\n- [ ] ${sentence(4)}\n\n${paragraph()}\n`;
  async function subtree(t: number) {
    const title = `Area ${t + 1} ${pick(WORDS)}`;
    const root = await createPage(owner, { workspaceId, title, markdown: body(title) }, { audit: false });
    made++;
    for (let c = 0; c < 10 && made < SCALE.pages; c++) {
      const childTitle = `${pick(WORDS)} ${pick(WORDS)} ${t + 1}.${c + 1}`;
      const child = await createPage(owner, { workspaceId, parentId: root.id, title: childTitle, markdown: body(childTitle) }, { audit: false });
      made++;
      for (let g = 0; g < 9 && made < SCALE.pages; g++) {
        const leafTitle = `${pick(WORDS)} ${pick(WORDS)} ${t + 1}.${c + 1}.${g + 1}`;
        await createPage(owner, { workspaceId, parentId: child.id, title: leafTitle, markdown: body(leafTitle) }, { audit: false });
        made++;
      }
    }
  }
  const queue = Array.from({ length: top }, (_, t) => t);
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) await subtree(t);
    }),
  );
  // Private pages and pages shared with someone, as in any workspace in use: with a page's own
  // permissions anywhere in the workspace, access is worked out from each page's ancestors.
  const shared = await db
    .select({ id: page.id })
    .from(page)
    .where(and(eq(page.workspaceId, workspaceId), eq(page.kind, "page")))
    .orderBy(page.createdAt)
    .limit(20);
  for (const [i, { id }] of shared.entries()) {
    await setPagePermission(SCALE.owner, id, `scale-e2e-${PEOPLE[i % PEOPLE.length].toLowerCase()}`, i % 2 ? "view" : "edit");
  }
  for (const userId of [SCALE.owner, ...PEOPLE.map((p) => `scale-e2e-${p.toLowerCase()}`)]) {
    for (let i = 0; i < 3; i++) {
      const title = `Private ${pick(WORDS)} ${i + 1}`;
      await createPage({ userId }, { workspaceId, teamspaceId: null, title, markdown: body(title) }, { audit: false });
      made++;
    }
  }
  console.log(`${made} pages in ${((Date.now() - started) / 1000).toFixed(0)} s`);

  // ---------------------------------------------------------------- the database
  const rowsStarted = Date.now();
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: SCALE.databaseTitle }, { audit: false });
  await addProperty(SCALE.owner, tasks.id, { name: "Priority", type: "select", options: ["Low", "Medium", "High", "Urgent"] });
  await addProperty(SCALE.owner, tasks.id, { name: "Amount", type: "number" });
  await addProperty(SCALE.owner, tasks.id, { name: "Due", type: "date" });
  await addProperty(SCALE.owner, tasks.id, { name: "Owner", type: "person" });
  await addProperty(SCALE.owner, tasks.id, { name: "Done", type: "checkbox" });
  await addProperty(SCALE.owner, tasks.id, { name: "Notes", type: "text" });
  await addProperty(SCALE.owner, tasks.id, { name: "Total", type: "formula", formula: { expression: 'prop("Amount") * 1.2' } });
  const props = await getProperties(tasks.id);
  const byName = (name: string) => props.find((p) => p.name === name)!;
  const status = byName("Status");
  const tags = byName("Tags");
  // The starter Tags property has no options yet: give it some, as rows would.
  const tagOptions = ["red", "blue", "green", "ops", "sales", "field", "office", "urgent"].map((name, i) => ({ id: crypto.randomUUID(), name, color: ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink"][i] }));
  await db.execute(sql`update database_property set options = ${JSON.stringify({ options: tagOptions })}::jsonb where id = ${tags.id}`);
  const priority = byName("Priority");
  const ids = {
    status: status.options.options!.map((o) => o.id),
    priority: priority.options.options!.map((o) => o.id),
    tags: tagOptions.map((o) => o.id),
    people: [SCALE.owner, ...PEOPLE.map((p) => `scale-e2e-${p.toLowerCase()}`)],
  };
  const day = (offset: number) => new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
  const CHUNK = 1_000;
  for (let i = 0; i < SCALE.rows; i += CHUNK) {
    const rows = Array.from({ length: Math.min(CHUNK, SCALE.rows - i) }, (_, j) => {
      const n = i + j + 1;
      const tagCount = Math.floor(rand() * 4);
      const values: Record<string, unknown> = {
        [status.id]: pick(ids.status),
        [priority.id]: pick(ids.priority),
        [tags.id]: [...new Set(Array.from({ length: tagCount }, () => pick(ids.tags)))],
        [byName("Amount").id]: Math.round(rand() * 1_000_000) / 100,
        [byName("Due").id]: day(Math.floor(rand() * 730) - 365),
        [byName("Owner").id]: [pick(ids.people)],
        [byName("Done").id]: rand() < 0.3,
        [byName("Notes").id]: sentence(8),
      };
      return { title: `Task ${n} ${pick(WORDS)} ${pick(WORDS)}`, properties: values };
    });
    await insertRows({ id: tasks.id, workspaceId }, SCALE.owner, rows);
    if ((i / CHUNK) % 10 === 9) console.log(`${i + rows.length} rows…`);
  }
  // Rows written with people in them queue an assignment email each, as an import's do. No one reads
  // them here, and a server sending some forty thousand emails would be timed instead of the workspace.
  await db.execute(sql`delete from assignment_email where property_id = ${byName("Owner").id}`);
  console.log(`${SCALE.rows} rows in ${((Date.now() - rowsStarted) / 1000).toFixed(0)} s`);
  return workspaceId;
}

try {
  if (process.argv.includes("--fresh")) await removeAll();
  const found = await existing();
  if (found) {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(page).where(eq(page.workspaceId, found));
    console.log(`The scale workspace is already there (${count} pages and rows); --fresh makes it again.`);
  } else {
    const workspaceId = await seed();
    console.log(`Seeded workspace ${workspaceId}`);
  }
} finally {
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
