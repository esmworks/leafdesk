/**
 * End-to-end check that childVisibleTo (server/access.ts), which works out a database's rows' access
 * once for the database, lets each person see exactly the rows pageVisibleTo (page_access_level
 * asked of every row) lets them see: rows shared on their own (with everyone, a person or a group),
 * entries on the database instead, a row outside its database's teamspace, the children of a
 * private page, a database 62 to 65 levels down (the walk up from its rows stops a step before the
 * walk up from it), and an agent acting for a member. Each case is set up in a transaction that is
 * rolled back. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/row-access-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. The case of a row in
 * another teamspace switches off the triggers that keep it in its database's, which takes a database
 * superuser (as in CI and the development database).
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { user, workspace } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { childVisibleTo, pageVisibleTo } = await import("@/server/access");
const { runActingFor } = await import("@/server/acting-for");
const { createPage } = await import("@/server/pages");
const { insertRows } = await import("@/server/databases");
const { addMemberAs, createWorkspace } = await import("@/server/workspaces");

const RUN = `row-access-e2e-${Date.now().toString(36)}`;

// Writes notify open editors through the collab service, which only runs inside the app server.
registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async setTitle() {},
  async disconnectUser() {},
  async disconnectTeamspace() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
} as unknown as Parameters<typeof registerCollab>[0]);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const ids = { owner: `${RUN}-owner`, ada: `${RUN}-ada`, bora: `${RUN}-bora`, guest: `${RUN}-guest` };
// Someone outside the workspace is asked too.
const people = [...Object.values(ids), `${RUN}-outsider`];
let workspaceId = "";

try {
  await db.insert(user).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: true })));
  workspaceId = (await createWorkspace(ids.owner, `${RUN} workspace`)).id;
  await addMemberAs(ids.owner, workspaceId, `${ids.ada}@example.test`, "member");
  await addMemberAs(ids.owner, workspaceId, `${ids.bora}@example.test`, "member");
  await addMemberAs(ids.owner, workspaceId, `${ids.guest}@example.test`, "guest");
  const owner = { userId: ids.owner };
  const database = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" }, { audit: false });
  await insertRows({ id: database.id, workspaceId }, ids.owner, Array.from({ length: 40 }, (_, i) => ({ title: `Task ${i + 1}`, properties: {} })));
  const rows = (await db.execute<{ id: string }>(sql`select id from page where parent_id = ${database.id} order by position, created_at`)).map((r) => r.id);
  // A private page (its own entries make the workspace's access walk up from each page) with children.
  const mine = await createPage(owner, { workspaceId, teamspaceId: null, title: "Private" }, { audit: false });
  const children: string[] = [];
  for (let i = 0; i < 3; i++) children.push((await createPage(owner, { workspaceId, parentId: mine.id, title: `Child ${i + 1}` }, { audit: false })).id);
  // Top-level pages to string into a chain above the database.
  const chain: string[] = [];
  for (let i = 0; i < 65; i++) chain.push((await createPage(owner, { workspaceId, title: `Level ${i + 1}` }, { audit: false })).id);

  const entry = (pageId: string, userId: string | null, level: string) =>
    sql`insert into page_permission (id, page_id, workspace_id, user_id, level) values (${crypto.randomUUID()}, ${pageId}, ${workspaceId}, ${userId}, ${level})`;
  const group = async (tx: Tx, members: string[]) => {
    const id = crypto.randomUUID();
    await tx.execute(sql`insert into member_group (id, workspace_id, name) values (${id}, ${workspaceId}, ${`${RUN} group`})`);
    for (const m of members) await tx.execute(sql`insert into member_group_member (group_id, workspace_id, user_id) values (${id}, ${workspaceId}, ${m})`);
    return id;
  };
  const groupEntry = (pageId: string, groupId: string, level: string) =>
    sql`insert into page_group_permission (id, page_id, workspace_id, group_id, level) values (${crypto.randomUUID()}, ${pageId}, ${workspaceId}, ${groupId}, ${level})`;

  /** Each person's visible children of `parentId`, both ways; their differences. */
  async function compare(tx: Tx, parentId: string) {
    const differences: { userId: string; id: string; perRow: boolean; once: boolean }[] = [];
    const visible: Record<string, number> = {};
    for (const userId of people) {
      const found = await tx.execute<{ id: string; per_row: boolean; once: boolean }>(
        sql`select p.id, ${pageVisibleTo(userId, "p")} as per_row, ${childVisibleTo(userId, parentId, "p")} as once
            from page p where p.parent_id = ${parentId}`,
      );
      visible[userId] = found.filter((r) => r.per_row).length;
      for (const r of found) if (r.per_row !== r.once) differences.push({ userId, id: r.id, perRow: r.per_row, once: r.once });
    }
    return { differences, visible };
  }

  class Rollback extends Error {}
  /** Sets up a case in a transaction, compares the children of the parents it returns, rolls back. */
  async function inCase(label: string, setup: (tx: Tx) => Promise<string[]>, also?: (visible: Record<string, number>[]) => void) {
    let seen: Record<string, number>[] = [];
    let differences: unknown[] = [];
    try {
      await db.transaction(async (tx) => {
        for (const parentId of await setup(tx)) {
          const result = await compare(tx, parentId);
          differences = [...differences, ...result.differences];
          seen = [...seen, result.visible];
        }
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    check(differences.length === 0, `${label}: the same rows either way`, differences.slice(0, 10));
    also?.(seen);
  }

  await inCase("as created", async () => [database.id], ([rowsSeen]) => {
    check(rowsSeen[ids.ada] === rows.length && rowsSeen[ids.guest] === 0 && rowsSeen[`${RUN}-outsider`] === 0, "…members see the rows, a guest and an outsider none", rowsSeen);
  });
  await inCase("rows shared on their own", async (tx) => {
    const design = await group(tx, [ids.ada, ids.bora]);
    await tx.execute(entry(rows[0], null, "none"));
    await tx.execute(entry(rows[1], null, "none"));
    await tx.execute(entry(rows[1], ids.ada, "view"));
    await tx.execute(entry(rows[2], null, "none"));
    await tx.execute(groupEntry(rows[2], design, "edit"));
    await tx.execute(entry(rows[3], ids.bora, "none"));
    await tx.execute(entry(rows[4], ids.guest, "view"));
    return [database.id];
  }, ([rowsSeen]) => {
    check(rowsSeen[ids.ada] === rows.length - 1 && rowsSeen[ids.guest] === 1, "…a row hidden from everyone but those it is shared with", rowsSeen);
  });
  await inCase("entries on the database", async (tx) => {
    await tx.execute(entry(database.id, null, "none"));
    await tx.execute(entry(database.id, ids.bora, "view"));
    await tx.execute(entry(rows[0], ids.ada, "edit"));
    return [database.id];
  }, ([rowsSeen]) => {
    check(rowsSeen[ids.bora] === rows.length && rowsSeen[ids.ada] === 1, "…the database's entries reach its rows", rowsSeen);
  });
  await inCase("a group's entry on the database", async (tx) => {
    const design = await group(tx, [ids.bora]);
    await tx.execute(entry(database.id, null, "none"));
    await tx.execute(groupEntry(database.id, design, "view"));
    return [database.id];
  });
  await inCase("a row outside its database's teamspace", async (tx) => {
    // The teamspace triggers keep a row in its database's teamspace; switched off to make one that isn't.
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql`update page set teamspace_id = null where id = ${rows[0]}`);
    await tx.execute(entry(database.id, null, "view"));
    return [database.id];
  });
  await inCase("a private page's children", async (tx) => {
    await tx.execute(entry(children[1], ids.ada, "view"));
    return [mine.id];
  }, ([childrenSeen]) => {
    check(childrenSeen[ids.owner] === 3 && childrenSeen[ids.ada] === 1, "…its owner sees them, others only what is shared", childrenSeen);
  });
  // The database `depth` levels below the top: from its rows the walk up takes one step more.
  for (const depth of [62, 63, 64, 65]) {
    await inCase(
      `a database ${depth} levels down`,
      async (tx) => {
        const levels = chain.slice(0, depth);
        for (let i = 1; i < levels.length; i++) await tx.execute(sql`update page set parent_id = ${levels[i - 1]} where id = ${levels[i]}`);
        await tx.execute(sql`update page set parent_id = ${levels.at(-1)!} where id = ${database.id}`);
        return [database.id, levels.at(-1)!];
      },
      ([rowsSeen, databaseSeen]) => {
        if (depth === 64) {
          check(rowsSeen[ids.owner] === 0 && databaseSeen[ids.owner] === 1, "…at 64 the database is seen and its rows are not (the walk up from them stops short)", {
            rowsSeen,
            databaseSeen,
          });
        }
      },
    );
  }
  await inCase("a database whose rows are restricted to the people they name", async (tx) => {
    const assignee = crypto.randomUUID();
    await tx.execute(sql`insert into database_property (id, database_id, name, type) values (${assignee}, ${database.id}, 'Assignee', 'person')`);
    await tx.execute(sql`update page set properties = jsonb_build_object(${assignee}::text, jsonb_build_array(${ids.ada}::text)) where id = ${rows[0]}`);
    await tx.execute(sql`update page set properties = jsonb_build_object(${assignee}::text, jsonb_build_array(${ids.guest}::text)) where id = ${rows[1]}`);
    const rules = JSON.stringify([{ kind: "person", propertyId: assignee, level: "edit" }]);
    await tx.execute(sql`insert into database_row_access (database_id, workspace_id, restricted, rules) values (${database.id}, ${workspaceId}, true, ${rules}::jsonb)`);
    // Full access sees every row (it can change the setting): members get edit, the owner keeps full.
    await tx.execute(entry(database.id, null, "edit"));
    await tx.execute(entry(database.id, ids.owner, "full"));
    return [database.id];
  }, ([rowsSeen]) => {
    check(
      rowsSeen[ids.ada] === 1 && rowsSeen[ids.guest] === 1 && rowsSeen[ids.bora] === 0 && rowsSeen[ids.owner] === rows.length,
      "…each sees the row that names them, full access every row",
      rowsSeen,
    );
  });
  await runActingFor({ userId: ids.ada, forUserId: ids.bora }, () =>
    inCase("an agent acting for a member", async (tx) => {
      await tx.execute(entry(database.id, null, "none"));
      await tx.execute(entry(database.id, ids.ada, "edit"));
      await tx.execute(entry(rows[0], ids.bora, "view"));
      return [database.id];
    }, ([rowsSeen]) => {
      check(rowsSeen[ids.ada] === 1, "…sees only the rows both may", rowsSeen);
    }),
  );

  console.log(`\n${passed} checks passed`);
} finally {
  if (workspaceId) await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
