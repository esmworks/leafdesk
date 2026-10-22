/**
 * The second half of the upgrade path test; scripts/upgrade-test.sh runs both. An older release
 * migrated an empty database and filled it through its own code (scripts/upgrade/seed.ts), writing
 * down what it reads back; this checkout's migrations then upgraded the database. This checks, with
 * this checkout's code:
 *
 * - migrations: drizzle.__drizzle_migrations has one row for each migration in the journal, and the
 *   journal's timestamps only go up (a migration dated before the last one a database ran is
 *   skipped there without a word);
 * - schema: tables, columns, defaults, indexes, constraints, triggers, functions, extensions, enums,
 *   sequences and views are those of a fresh install (FRESH_DATABASE_URL);
 * - data: every row and value of the older release's tables is as it was before the upgrade, but
 *   for what a migration changes on purpose (INTENDED_ROWS);
 * - reads: pages and their bodies (read from the stored documents by this checkout), history,
 *   comments, backlinks, databases with their properties, views and the rows each view shows,
 *   access levels, sharing, teamspaces, groups, templates, automations, API tokens, favorites,
 *   notifications, the trash, the published page, files and search give what the older release
 *   read, but for changes made on purpose (INTENDED_READS);
 * - the owner signs in with their password, the API token works, the stored files read back byte for
 *   byte, links get their places, search finds every page by its title, and this checkout goes on
 *   writing the older release's pages, rows, comments, history and automations.
 *
 *   node_modules/.bin/tsx scripts/upgrade-e2e.ts --empty                 # before: both databases empty?
 *   node_modules/.bin/tsx scripts/upgrade-e2e.ts --dump <before.json>    # every table, before upgrading
 *   node_modules/.bin/tsx scripts/upgrade-e2e.ts <manifest.json> <before.json>
 *
 * Env: DATABASE_URL (the upgraded database), FRESH_DATABASE_URL (a fresh install of this checkout),
 * UPLOAD_DIR (absolute: where the older release stored files) and BETTER_AUTH_SECRET (the one the
 * older release ran with), read from .env when present. scripts/upgrade-test.sh sets them all.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { createHash } = await import("node:crypto");
const { readFile, writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");
const { default: postgres } = await import("postgres");
const { readMigrationFiles } = await import("drizzle-orm/migrator");

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;
type Table = { primaryKey: string[]; columns: { name: string; type: string }[]; rows: Record<string, Row> };
type Dump = Record<string, Table>;
type Read = { kind: string; args: any[]; result?: unknown; error?: string };
type Person = { id: string; name: string; email: string };
type Manifest = {
  version: string;
  uploadDir: string;
  people: { owner: Person; member: Person; guest: Person; former: Person };
  ownerPassword: string;
  workspaceId: string;
  databases: { projects: string; tasks: string };
  pages: { id: string; title: string; kind: string; parentId: string | null }[];
  token: { id: string; secret: string };
  formerToken: { id: string; secret: string };
  formerGrants: { pagePermissionIds: string[]; propertyPermissionIds: string[]; apiTokenIds: string[] };
  files: { id: string; name: string; sha256: string }[];
  links: { sourceId: string; targetId: string }[];
  access: { userId: string; pageId: string; level: string }[];
  reads: Read[];
};
type Difference = { path: string; before: unknown; after: unknown };

const root = join(import.meta.dirname, "..");
/** The schemas migrations write to: the app's tables, and drizzle's record of applied migrations. */
const SCHEMAS = ["public", "drizzle"];

const connect = (url: string) => postgres(url, { max: 1, onnotice: () => {}, connection: { TimeZone: "UTC" } });
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** Plain JSON, as the seed wrote the older release's reads: dates as ISO strings, undefined left out. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** `value` with `fn` applied to each string in it, at any depth. */
const mapStrings = (value: unknown, fn: (s: string) => string): unknown =>
  typeof value === "string"
    ? fn(value)
    : Array.isArray(value)
      ? value.map((v) => mapStrings(v, fn))
      : value !== null && typeof value === "object"
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]))
        : value;
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : (error as Error).name || "Error";
};

let passed = 0;
let failed = 0;
function check(condition: unknown, label: string, detail?: unknown): boolean {
  if (!condition) {
    failed++;
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
    return false;
  }
  passed++;
  console.log(`ok    ${label}`);
  return true;
}

/**
 * Where `after` differs from `before`, path by path. Objects compare by `before`'s keys only: fields
 * this checkout added to what a read returns are fine. Arrays compare item by item, in order.
 */
function differences(before: unknown, after: unknown, path = "", out: Difference[] = []): Difference[] {
  if (out.length >= 12) return out;
  const brief = (v: unknown) => (Array.isArray(v) ? `array of ${v.length}` : v);
  if (Array.isArray(before)) {
    if (!Array.isArray(after) || after.length !== before.length) out.push({ path, before: brief(before), after: brief(after) });
    else before.forEach((b, i) => differences(b, after[i], `${path}[${i}]`, out));
  } else if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) out.push({ path, before: "object", after: brief(after) });
    else for (const [key, value] of Object.entries(before)) differences(value, (after as Row)[key], path ? `${path}.${key}` : key, out);
  } else if (before !== after) {
    out.push({ path, before, after });
  }
  return out;
}

/**
 * Every row of every table in the public schema, keyed by primary key: values as JSON, binary ones
 * as their MD5, generated columns (derived from the others) left out.
 */
async function dumpTables(sql: Sql): Promise<Dump> {
  const dump: Dump = {};
  const tables = await sql<{ name: string }[]>`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`;
  for (const { name } of tables) {
    const relation = `public.${quote(name)}`;
    const columns = await sql<{ name: string; type: string; binary: boolean; generated: boolean }[]>`
      select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
        a.atttypid = 'bytea'::regtype as binary, a.attgenerated <> '' as generated
      from pg_attribute a
      where a.attrelid = ${relation}::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`;
    const primaryKey = (
      await sql<{ name: string }[]>`
        select a.attname as name from pg_index i
        join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
        where i.indrelid = ${relation}::regclass and i.indisprimary
        order by array_position(i.indkey::int2[], a.attnum)`
    ).map((r) => r.name);
    const kept = columns.filter((c) => !c.generated);
    const binary = kept.filter((c) => c.binary).map((c) => c.name);
    const dropped = [...columns.filter((c) => c.generated).map((c) => c.name), ...binary];
    // Names come from the catalog: plain identifiers.
    const rows = await sql.unsafe<{ row: Row; hashes: (string | null)[] | null }[]>(
      `select to_jsonb(t)${dropped.length ? ` - array[${dropped.map((c) => `'${c}'`).join(", ")}]::text[]` : ""} as row,
        ${binary.length ? `array[${binary.map((c) => `md5(t.${quote(c)})`).join(", ")}]` : "null"} as hashes
      from ${relation} t`,
    );
    const table: Table = { primaryKey, columns: kept.map(({ name, type }) => ({ name, type })), rows: {} };
    for (const { row, hashes } of rows) {
      binary.forEach((c, i) => (row[c] = hashes?.[i] ?? null));
      let key = JSON.stringify(primaryKey.length ? primaryKey.map((c) => row[c]) : row);
      while (key in table.rows) key += "+";
      table.rows[key] = row;
    }
    dump[name] = table;
  }
  return dump;
}

/** The schema as the catalog describes it, by kind of object, each object by name. */
async function schemaOf(sql: Sql): Promise<Record<string, Row[]>> {
  return {
    tables: await sql`
      select n.nspname || '.' || c.relname as name, c.relkind as kind, c.relpersistence as persistence,
        coalesce(c.reloptions, '{}') as options, c.relrowsecurity as row_security
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ${sql(SCHEMAS)} and c.relkind in ('r', 'p', 'v', 'm', 'f')`,
    columns: await sql`
      select n.nspname || '.' || c.relname || '.' || a.attname as name,
        row_number() over (partition by c.oid order by a.attnum) as position,
        format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
        pg_get_expr(d.adbin, d.adrelid) as default, a.attgenerated as generated, a.attidentity as identity,
        a.attcollation::regcollation::text as collation
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname in ${sql(SCHEMAS)} and c.relkind in ('r', 'p', 'v', 'm', 'f') and a.attnum > 0 and not a.attisdropped`,
    indexes: await sql`
      select schemaname || '.' || indexname as name, tablename as table, indexdef as definition
      from pg_indexes where schemaname in ${sql(SCHEMAS)}`,
    constraints: await sql`
      select n.nspname || '.' || c.relname || '.' || con.conname as name, con.contype as type,
        pg_get_constraintdef(con.oid) as definition, con.condeferrable as deferrable,
        con.condeferred as deferred, con.convalidated as validated
      from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ${sql(SCHEMAS)}`,
    triggers: await sql`
      select n.nspname || '.' || c.relname || '.' || t.tgname as name, pg_get_triggerdef(t.oid) as definition,
        t.tgenabled as enabled
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname in ${sql(SCHEMAS)}`,
    functions: await sql`
      select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name,
        pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ${sql(SCHEMAS)} and p.prokind in ('f', 'p')`,
    extensions: await sql`
      select e.extname as name, e.extversion as version, n.nspname as schema
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace`,
    enums: await sql`
      select n.nspname || '.' || t.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname in ${sql(SCHEMAS)}
      group by 1`,
    sequences: await sql`
      select schemaname || '.' || sequencename as name, data_type::text as type, start_value::text as start,
        increment_by::text as increment, min_value::text as min, max_value::text as max, cycle
      from pg_sequences where schemaname in ${sql(SCHEMAS)}`,
    views: await sql`
      select schemaname || '.' || viewname as name, definition from pg_views where schemaname in ${sql(SCHEMAS)}`,
    policies: await sql`
      select schemaname || '.' || tablename || '.' || policyname as name, permissive, roles::text as roles, cmd,
        qual, with_check
      from pg_policies where schemaname in ${sql(SCHEMAS)}`,
  };
}

/** --empty: the driver's first step, so a run never fills or "upgrades" a database in use. */
async function checkEmpty() {
  for (const name of ["DATABASE_URL", "FRESH_DATABASE_URL"]) {
    const url = process.env[name];
    if (!check(url, `${name} is set`)) continue;
    const sql = connect(url!);
    try {
      const [{ relations }] = await sql<{ relations: number }[]>`
        select count(*)::int as relations from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast|temp)'`;
      check(relations === 0, `${name} names an empty database`, relations ? { relations } : undefined);
    } finally {
      await sql.end();
    }
  }
}

async function checkUpgrade(manifestPath: string, beforePath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const before = JSON.parse(await readFile(beforePath, "utf8")) as Dump;
  const from = manifest.version;
  const sql = connect(process.env.DATABASE_URL!);
  const fresh = connect(process.env.FRESH_DATABASE_URL!);
  try {
    // ----- Migrations
    const journal = JSON.parse(await readFile(join(root, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: { when: number; tag: string }[];
    };
    // In journal order: migrations[i] is journal.entries[i].
    const migrations = readMigrationFiles({ migrationsFolder: join(root, "drizzle") });
    check(
      journal.entries.every((e, i) => i === 0 || e.when > journal.entries[i - 1].when),
      `the journal's ${journal.entries.length} migrations are dated in order, so none is skipped where a later one ran`,
      journal.entries.filter((e, i) => i > 0 && e.when <= journal.entries[i - 1].when).map((e) => e.tag),
    );
    for (const [which, conn] of [
      ["the upgraded database", sql],
      ["the fresh install", fresh],
    ] as const) {
      const applied = await conn<{ hash: string; created_at: string }[]>`
        select hash, created_at::text from drizzle.__drizzle_migrations order by id`;
      const recorded = new Set(applied.map((r) => `${r.hash}@${r.created_at}`));
      const missing = journal.entries.filter((_, i) => !recorded.has(`${migrations[i].hash}@${migrations[i].folderMillis}`));
      check(
        applied.length === journal.entries.length && !missing.length,
        `${which} records each migration in the journal as applied, once`,
        { recorded: applied.length, journal: journal.entries.length, missing: missing.map((e) => e.tag) },
      );
    }

    // ----- Schema
    const [upgradedSchema, freshSchema] = [await schemaOf(sql), await schemaOf(fresh)];
    for (const [kind, freshObjects] of Object.entries(freshSchema)) {
      const mine = new Map(upgradedSchema[kind].map((o) => [String(o.name), JSON.stringify(o)]));
      const theirs = new Map(freshObjects.map((o) => [String(o.name), JSON.stringify(o)]));
      const missing = [...theirs.keys()].filter((name) => !mine.has(name));
      const extra = [...mine.keys()].filter((name) => !theirs.has(name));
      const changed = [...theirs.keys()]
        .filter((name) => mine.has(name) && mine.get(name) !== theirs.get(name))
        .map((name) => ({ upgraded: JSON.parse(mine.get(name)!), fresh: JSON.parse(theirs.get(name)!) }));
      check(
        !missing.length && !extra.length && !changed.length,
        `the upgraded database has the ${theirs.size} ${kind} of a fresh install`,
        { missing, extra, changed },
      );
    }

    // ----- Data: the older release's rows, before and after
    const after = await dumpTables(sql);
    const deletedOnPurpose = new Map([
      ["page_permission", new Set(manifest.formerGrants.pagePermissionIds)],
      ["property_permission", new Set(manifest.formerGrants.propertyPermissionIds)],
      ["api_token", new Set(manifest.formerGrants.apiTokenIds)],
    ]);
    /**
     * What the migrations since the older release change in its rows on purpose; any other
     * difference fails.
     */
    const INTENDED_ROWS = {
      // 0056_forget_former_members_grants (5fd4da74): what people were given in a workspace they
      // have left goes: here the former member's page and property grants and workspace API token.
      deleted: (table: string, row: Row) => deletedOnPurpose.get(table)?.has(String(row.id)) ?? false,
      // 0055_security_hardening (6b7eedb7): sign-in providers' tokens aren't kept any more.
      changed: (table: string, column: string, value: unknown) =>
        table === "account" && ["access_token", "refresh_token", "id_token"].includes(column) && value === null,
    };
    const lost: unknown[] = [];
    const changed: unknown[] = [];
    const appeared: Record<string, number> = {};
    const deleted: Record<string, string[]> = {};
    let rows = 0;
    for (const [name, old] of Object.entries(before)) {
      const now = after[name];
      if (!now) {
        lost.push({ table: name });
        continue;
      }
      for (const column of old.columns) {
        const kept = now.columns.find((c) => c.name === column.name);
        if (!kept || kept.type !== column.type) lost.push({ table: name, column: column.name, type: column.type, now: kept?.type ?? null });
      }
      for (const [key, row] of Object.entries(old.rows)) {
        rows++;
        const next = now.rows[key];
        if (!next) {
          if (INTENDED_ROWS.deleted(name, row)) (deleted[name] ??= []).push(String(row.id));
          else lost.push({ table: name, row: key });
          continue;
        }
        for (const [column, value] of Object.entries(row)) {
          if (!(column in next) || JSON.stringify(value) === JSON.stringify(next[column])) continue;
          if (!INTENDED_ROWS.changed(name, column, next[column])) changed.push({ table: name, row: key, column, before: value, after: next[column] });
        }
      }
      const added = Object.keys(now.rows).filter((key) => !(key in old.rows)).length;
      if (added) appeared[name] = added;
    }
    check(!lost.length, `the upgrade keeps all ${Object.keys(before).length} tables of ${from} with their columns and ${rows} rows`, lost.slice(0, 20));
    check(!changed.length, "…and every value in them, but for provider tokens 0055 clears", changed.slice(0, 20));
    check(!Object.keys(appeared).length, "…and adds no rows to them", appeared);
    check(
      [...deletedOnPurpose].every(([table, ids]) => [...ids].sort().join() === (deleted[table] ?? []).sort().join()),
      `0056 removes the former member's ${manifest.formerGrants.pagePermissionIds.length} page grants, property grant and API token`,
      { deleted, expected: Object.fromEntries([...deletedOnPurpose].map(([table, ids]) => [table, [...ids]])) },
    );
    const providerAccount = Object.values(after.account.rows).find((r) => r.provider_id === "github");
    check(
      providerAccount && providerAccount.access_token === null && providerAccount.refresh_token === null,
      "0055 clears the tokens of the sign-in provider account",
      providerAccount,
    );
    const references = Object.values(after.file_reference?.rows ?? {});
    check(
      references.length > 0 && references.every((r) => r.authorized === true),
      `0057 keeps the ${references.length} file references ${from} made readable (authorized)`,
      references.filter((r) => r.authorized !== true),
    );
  } finally {
    await sql.end();
    await fresh.end();
  }

  // ----- Reads with this checkout's code. Imported now: the database client reads DATABASE_URL
  // when it is created, and nothing above may touch the database through the app.
  const { and, eq, isNull } = await import("drizzle-orm");
  const Y = await import("yjs");
  const { verifyPassword } = await import("better-auth/crypto");
  const { effectiveScopes } = await import("@/lib/api-scopes");
  const { db } = await import("@/db");
  const schema = await import("@/db/schema");
  const { createCollab } = await import("@/server/collab/service");
  const { getCollab, registerCollab } = await import("@/server/collab/bridge");
  const { resolvePageAccess } = await import("@/server/access");
  const pages = await import("@/server/pages");
  const databases = await import("@/server/databases");
  const workspaces = await import("@/server/workspaces");
  const teamspaces = await import("@/server/teamspaces");
  const groups = await import("@/server/groups");
  const permissions = await import("@/server/permissions");
  const propertyAccess = await import("@/server/property-access");
  const comments = await import("@/server/comments");
  const files = await import("@/server/files");
  const templates = await import("@/server/templates");
  const tokens = await import("@/server/api/tokens");
  const automations = await import("@/server/automations/manage");
  const { flushAutomations } = await import("@/server/automations/run");
  const mentions = await import("@/server/mentions");
  const pageMeta = await import("@/server/page-meta");
  const publication = await import("@/server/publication");
  const notifications = await import("@/server/notifications");
  const { bodyBlocks } = await import("@/server/synced-body");
  const { blocksToMarkdown } = await import("@/server/blocknote");
  const { blocksToPlainText } = await import("@/lib/blocks");
  const { pageStyleFromYdoc } = await import("@/lib/page-style");
  const { auth } = await import("@/lib/auth");

  const { hocuspocus, service } = createCollab();
  registerCollab(service);
  const people = manifest.people;
  const owner = people.owner.id;
  const workspaceId = manifest.workspaceId;
  const pageId = (title: string) => {
    const found = manifest.pages.find((p) => p.title === title);
    if (!found) throw new Error(`the seed made no page "${title}"`);
    return found.id;
  };
  const readsOf = (kind: string) => manifest.reads.filter((r) => r.kind === kind);
  try {
    /** The current code's call for each read the seed made with the older release. */
    const readers: Record<string, (...args: any[]) => Promise<unknown>> = {
      readPage: (id) => getCollab().readPage(id),
      readBlocks: (id) => getCollab().readBlocks(id),
      pageStyle: async (id) => {
        const [row] = await db.select({ ydoc: schema.page.ydoc }).from(schema.page).where(eq(schema.page.id, id));
        return pageStyleFromYdoc(row?.ydoc);
      },
      listComments: (userId, id) => comments.listComments(userId, id),
      listSnapshots: (userId, id) => pages.listSnapshots(userId, id),
      getSnapshot: (userId, id) => pages.getSnapshot(userId, id),
      listBacklinks: (userId, id) => mentions.listBacklinks(userId, id),
      listPagePermissions: (userId, id) => permissions.listPagePermissions(userId, id),
      getBreadcrumbs: (userId, id) => pages.getBreadcrumbs(userId, id),
      getDatabase: async (userId, id) => {
        const { database, properties, views, propertyAccess: access } = await databases.getDatabase(userId, id);
        return { database, properties, views, propertyAccess: access };
      },
      listRows: (userId, id) => databases.listRows(userId, id),
      listRowsInView: async (userId, id, viewId) => {
        const view = (await databases.getDatabase(owner, id)).views.find((v) => v.id === viewId);
        if (!view) throw Object.assign(new Error(`no view ${viewId}`), { code: "noView" });
        return (await databases.listRows(userId, id, view.config)).map((r) => r.id);
      },
      listAutomations: (userId, id) => automations.listAutomations(userId, id),
      listRowTemplates: (userId, id) => templates.listRowTemplates(userId, id),
      getPropertyAccessSettings: (userId, id) => propertyAccess.getPropertyAccessSettings(userId, id),
      getTree: (userId, id) => pages.getTree(userId, id),
      listFavorites: (userId, id) => pageMeta.listFavorites(userId, id),
      listApiTokens: (userId) => tokens.listApiTokens(userId),
      listTemplates: (userId, id) => templates.listTemplates(userId, id),
      listTrash: (userId, id) => pages.listTrash(userId, id),
      listTeamspaces: (userId, id) => teamspaces.listTeamspaces(userId, id),
      listTeamspaceMembers: (userId, id) => teamspaces.listTeamspaceMembers(userId, id),
      listTeamspaceGroups: (userId, id) => teamspaces.listTeamspaceGroups(userId, id),
      listGroups: (userId, id) => groups.listGroups(userId, id),
      listMembers: (userId, id) => workspaces.listMembers(userId, id),
      getWorkspaceSettings: (userId, id) => workspaces.getWorkspaceSettings(userId, id),
      getPublication: (userId, id) => publication.getPublication(userId, id),
      getPublishedPage: (token) => publication.getPublishedPage(token),
      listNotifications: (userId, options) => notifications.listNotifications(userId, options),
      searchPages: async (userId, query, id) => (await pages.searchPages(userId, query, { workspaceId: id })).map((h) => h.id),
      fileForViewer: async (userId, id) => (await files.fileForViewer(userId, id))?.id ?? null,
      getSession: async (cookie) => (await auth.api.getSession({ headers: new Headers({ cookie }) }))?.user.id ?? null,
    };
    const former = people.former.id;
    const byTimeThenId = (items: { createdAt: string; id: string }[]) =>
      [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    const byKindThenId = (items: { kind: string; id: string }[]) =>
      [...items].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    /**
     * Differences from the older release's reads that come from changes made on purpose, by read:
     * `before` turns what the older release read into what it reads now, `now` turns this
     * checkout's read into what the older release would have shown. Lists whose order was never
     * fixed are put in one order on both sides.
     */
    const INTENDED_READS: Record<string, { before?: (read: any) => unknown; now?: (read: any) => unknown }> = {
      // 0056_forget_former_members_grants (5fd4da74): the grants of people who left a workspace
      // go, here the former member's exception on a property… Exceptions saved together share
      // their time, the only order they have.
      getPropertyAccessSettings: {
        before: (read) => ({
          ...read,
          exceptions: byKindThenId(read.exceptions.filter((e: any) => !(e.kind === "user" && e.id === former))),
        }),
        now: (read) => ({ ...read, exceptions: byKindThenId(read.exceptions) }),
      },
      // …and their API token for the workspace they left. Tokens made before scopes per resource
      // keep their access as legacy ones, which list the scopes that access stands for
      // (0107_api_scopes_idempotency).
      listApiTokens: {
        before: (read) =>
          read
            .filter((t: any) => !manifest.formerGrants.apiTokenIds.includes(t.id))
            .map((t: any) => ({ ...t, scopes: effectiveScopes(t.scopes, true) })),
      },
      // Published pages mark each block, so a link can open the page at one (591bdc7a).
      getPublishedPage: { now: (read) => mapStrings(read, (s) => s.replace(/<span id="block-[^"]*" class="block-anchor"><\/span>/g, "")) },
      // Notifications one change makes share their time, and the inbox orders by time alone: the
      // order among those was never fixed, before or now.
      listNotifications: { before: byTimeThenId, now: byTimeThenId },
    };

    const kinds = [...new Set(manifest.reads.map((r) => r.kind))];
    for (const kind of kinds) {
      const reads = readsOf(kind);
      const differing: { args: unknown[]; differences: Difference[] }[] = [];
      for (const read of reads) {
        const reader = readers[kind];
        let now: { result?: unknown; error?: string };
        try {
          if (!reader) throw Object.assign(new Error(`no reader for ${kind}`), { code: "noReader" });
          now = { result: plain(await reader(...read.args)) };
        } catch (error) {
          now = { error: errorCode(error) };
        }
        let found: Difference[];
        if (read.error !== undefined || now.error !== undefined) {
          found = read.error === now.error ? [] : [{ path: "error", before: read.error ?? null, after: now.error ?? null }];
        } else if (kind === "searchPages") {
          // Ranking changed since (57ee2250) and search finds more than it did (words inside
          // Chinese and Japanese text, 7d2bd7c5; the text of documents, 2260d8c5): every page
          // found before is found still.
          const hits = new Set(now.result as string[]);
          found = (read.result as string[]).filter((id) => !hits.has(id)).map((id) => ({ path: "hits", before: id, after: null }));
        } else {
          const intended = INTENDED_READS[kind];
          found = differences(
            intended?.before ? intended.before(read.result) : read.result,
            intended?.now ? intended.now(now.result) : now.result,
          );
        }
        if (found.length) differing.push({ args: read.args, differences: found });
      }
      check(
        !differing.length,
        `${kind}: ${reads.length} reads give what ${from} read`,
        differing.length ? { differing: differing.length, first: differing.slice(0, 4) } : undefined,
      );
    }

    // Bodies: this checkout reading each stored document, as it does when it opens a page.
    const blocksBefore = new Map(readsOf("readBlocks").map((r) => [r.args[0] as string, r.result as { blocks: unknown[] }]));
    const contentBefore = new Map(readsOf("readPage").map((r) => [r.args[0] as string, r.result as { markdown: string; text: string }]));
    const derive = async (state: Uint8Array | null | undefined, id: string) => {
      const doc = new Y.Doc();
      try {
        if (state) Y.applyUpdate(doc, state);
        const blocks = bodyBlocks(doc, id);
        const markdown = (await blocksToMarkdown(blocks, { workspaceId })).trim();
        return { blocks: plain(blocks) as unknown[], markdown, text: blocksToPlainText(blocks) };
      } finally {
        doc.destroy();
      }
    };
    const derived = new Map<string, { blocks: unknown[]; markdown: string; text: string }>();
    const bodyDiffs: Record<"blocks" | "markdown" | "text", unknown[]> = { blocks: [], markdown: [], text: [] };
    for (const p of manifest.pages) {
      const [row] = await db.select({ ydoc: schema.page.ydoc }).from(schema.page).where(eq(schema.page.id, p.id));
      const body = await derive(row?.ydoc, p.id);
      derived.set(p.id, body);
      const blockDiffs = differences(blocksBefore.get(p.id)?.blocks, body.blocks);
      if (blockDiffs.length) bodyDiffs.blocks.push({ page: p.title, differences: blockDiffs });
      const old = contentBefore.get(p.id);
      if (body.markdown !== old?.markdown) bodyDiffs.markdown.push({ page: p.title, before: old?.markdown, after: body.markdown });
      if (body.text !== old?.text) bodyDiffs.text.push({ page: p.title, before: old?.text, after: body.text });
    }
    const n = manifest.pages.length;
    check(!bodyDiffs.blocks.length, `this checkout reads the same blocks from the ${n} documents ${from} stored`, bodyDiffs.blocks.slice(0, 3));
    check(!bodyDiffs.markdown.length, "…and makes the same Markdown of them", bodyDiffs.markdown.slice(0, 3));
    check(!bodyDiffs.text.length, "…and the same text", bodyDiffs.text.slice(0, 3));

    // Access, as resolved for each of the four people on each page.
    const accessDiffs: unknown[] = [];
    for (const a of manifest.access) {
      const { level } = await resolvePageAccess(a.userId, a.pageId);
      if (level !== a.level) accessDiffs.push({ ...a, now: level });
    }
    check(!accessDiffs.length, `the ${manifest.access.length} access levels of 4 people on ${n} pages are those ${from} resolved`, accessDiffs.slice(0, 20));

    // ----- What the older release wrote, used by this checkout
    const [credential] = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(and(eq(schema.account.userId, owner), eq(schema.account.providerId, "credential")));
    check(
      credential?.password && (await verifyPassword({ hash: credential.password, password: manifest.ownerPassword })),
      `the owner's password, hashed by ${from}, still matches`,
    );

    check(process.env.UPLOAD_DIR === manifest.uploadDir, `UPLOAD_DIR is where ${from} stored its files`, {
      UPLOAD_DIR: process.env.UPLOAD_DIR,
      seed: manifest.uploadDir,
    });
    const fileProblems: unknown[] = [];
    for (const f of manifest.files) {
      const [row] = await db.select().from(schema.file).where(eq(schema.file.id, f.id));
      const bytes = row ? await files.readStored(row) : null;
      if (!bytes || sha256(bytes) !== f.sha256) fileProblems.push({ file: f.name, found: !!row, read: !!bytes });
    }
    check(!fileProblems.length, `the ${manifest.files.length} files ${from} stored read back byte for byte`, fileProblems);

    const searchable = await db
      .select({ id: schema.page.id, title: schema.page.title })
      .from(schema.page)
      .where(and(eq(schema.page.workspaceId, workspaceId), isNull(schema.page.archivedAt), eq(schema.page.inTemplate, false)));
    const unfound: string[] = [];
    for (const p of searchable) {
      const hits = await pages.searchPages(owner, p.title, { workspaceId, limit: 50 });
      if (!hits.some((h) => h.id === p.id)) unfound.push(p.title);
    }
    check(!unfound.length, `search finds each of the ${searchable.length} pages by its title`, unfound);

    // Links indexed before they kept their places (0078) get them from the server's backfill.
    const waiting = await db.select({ sourceId: schema.pageLink.sourceId }).from(schema.pageLink).where(isNull(schema.pageLink.places));
    check(
      waiting.length === manifest.links.length,
      `the ${manifest.links.length} links ${from} indexed wait for their places`,
      { waiting: waiting.length },
    );
    let batch: number;
    do batch = await mentions.backfillLinkPlaces();
    while (batch > 0);
    const links = await db.select().from(schema.pageLink);
    const kept = manifest.links.filter((l) => links.some((k) => k.sourceId === l.sourceId && k.targetId === l.targetId));
    check(kept.length === manifest.links.length, "the backfill keeps each of them", { lost: manifest.links.length - kept.length });
    const placeless = links.filter((l) => !Array.isArray(l.places) || !l.places.length);
    check(!placeless.length, "…and finds the places each one links from", placeless.slice(0, 5));
    const handbookLinks = await mentions.listBacklinks(owner, pageId("Handbook"));
    check(
      handbookLinks.length > 0 && handbookLinks.every((b) => Array.isArray(b.places) && b.places.length > 0),
      `"Linked from" lists the handbook's ${handbookLinks.length} backlinks with their places`,
      handbookLinks,
    );

    const verified = await tokens.verifyApiToken(manifest.token.secret);
    check(
      verified.ok && verified.principal.userId === owner && verified.principal.tokenId === manifest.token.id,
      `the API token ${from} made still works, as its owner`,
      verified,
    );
    check(!(await tokens.verifyApiToken(manifest.formerToken.secret)).ok, "the former member's token, which 0056 removed, doesn't");

    const signedIn = await auth.api.signInEmail({ body: { email: people.owner.email, password: manifest.ownerPassword } }).catch((e) => e);
    check(signedIn?.user?.id === owner, "the owner signs in with their password", signedIn?.user ? undefined : String(signedIn));

    // ----- Writes with this checkout on what the older release wrote
    const actor = { userId: owner };
    const handbook = pageId("Handbook");
    await getCollab().appendContent(handbook, "Written after the upgrade.", actor);
    const appended = await getCollab().readPage(handbook);
    check(
      appended.markdown === `${derived.get(handbook)!.markdown}\n\nWritten after the upgrade.`,
      "adding to a page keeps all it had",
      { before: derived.get(handbook)!.markdown.slice(-200), after: appended.markdown.slice(-200) },
    );
    const threads = await comments.listComments(owner, handbook);
    const anchored = threads.find((t) => t.comments.length === 2);
    await comments.changeComments(people.member.id, handbook, { type: "addComment", threadId: anchored!.id, body: "Still true after the upgrade." });
    const replied = (await comments.listComments(owner, handbook)).find((t) => t.id === anchored!.id);
    check(replied?.comments.length === 3 && !replied.resolved, "a thread started before the upgrade takes a reply", replied);

    const locked = await getCollab()
      .replaceContent(pageId("Locked spec"), "Overwritten", actor)
      .then(() => null, (error: unknown) => errorCode(error));
    check(locked !== null, "the page locked before the upgrade still refuses writes", { error: locked });

    const meeting = pageId("Meeting notes");
    const [oldest] = await db
      .select({ id: schema.pageSnapshot.id, ydoc: schema.pageSnapshot.ydoc })
      .from(schema.pageSnapshot)
      .where(eq(schema.pageSnapshot.pageId, meeting))
      .orderBy(schema.pageSnapshot.createdAt)
      .limit(1);
    await pages.restoreSnapshot(actor, oldest.id);
    const restored = await getCollab().readPage(meeting);
    check(
      restored.markdown === (await derive(oldest.ydoc, meeting)).markdown,
      "restoring a version saved before the upgrade brings that version back",
      { restored: restored.markdown },
    );

    await pages.restorePage(owner, pageId("Old draft"));
    const tree = JSON.stringify(await pages.getTree(owner, workspaceId));
    check(
      !(await pages.listTrash(owner, workspaceId)).length && tree.includes(pageId("Old draft")) && tree.includes(pageId("Old draft appendix")),
      "a page trashed before the upgrade comes back from the trash with its subpage",
    );

    const tasks = await databases.getDatabase(owner, manifest.databases.tasks);
    const prop = (name: string) => tasks.properties.find((p) => p.name === name)!;
    const [created] = await databases.createRows(owner, manifest.databases.tasks, [
      { title: "Created after the upgrade", properties: { Status: "Not started" } },
    ]);
    await flushAutomations();
    const triaged = (await databases.listRows(owner, manifest.databases.tasks)).find((r) => r.id === created.id);
    const medium = (prop("Effort").options as { options?: { id: string; name: string }[] }).options?.find((o) => o.name === "M")?.id;
    check(
      triaged?.properties[prop("Effort").id] === medium && !!triaged?.properties[prop("Due").id],
      `an automation made by ${from} still runs on a new row, setting its effort and due date`,
      triaged?.properties,
    );
    const runs = await db
      .select({ name: schema.databaseAutomation.name, status: schema.automationRun.status })
      .from(schema.automationRun)
      .innerJoin(schema.databaseAutomation, eq(schema.databaseAutomation.id, schema.automationRun.automationId));
    check(
      runs.length === 1 && runs[0].name === "Triage new tasks",
      "…and the only run is that one (the webhook automation never fires)",
      runs,
    );

    const copy = (await databases.listRows(owner, manifest.databases.tasks)).find((r) => r.title === "Write the copy")!;
    const projectsDb = await databases.getDatabase(owner, manifest.databases.projects);
    const totalHours = projectsDb.properties.find((p) => p.name === "Total hours")!.id;
    const relaunch = () =>
      databases.listRows(owner, manifest.databases.projects).then((rows) => rows.find((r) => r.title === "Website relaunch")!);
    const hoursBefore = Number((await relaunch()).properties[totalHours]);
    await databases.updateRowProperties(owner, copy.id, { [prop("Hours").id]: Number(copy.properties[prop("Hours").id]) + 1 });
    const hoursAfter = Number((await relaunch()).properties[totalHours]);
    check(hoursAfter === hoursBefore + 1, "editing a row updates the rollup of its project", { hoursBefore, hoursAfter });
  } finally {
    hocuspocus.closeConnections();
    await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  }
}

const args = process.argv.slice(2);
if (args[0] === "--empty") {
  await checkEmpty();
} else if (args[0] === "--dump" && args[1]) {
  const sql = connect(process.env.DATABASE_URL!);
  try {
    const dump = await dumpTables(sql);
    await writeFile(args[1], JSON.stringify(dump));
    const rows = Object.values(dump).reduce((sum, t) => sum + Object.keys(t.rows).length, 0);
    console.log(`wrote ${Object.keys(dump).length} tables, ${rows} rows to ${args[1]}`);
  } finally {
    await sql.end();
  }
} else if (args.length === 2) {
  await checkUpgrade(args[0], args[1]);
} else {
  console.error("Usage: upgrade-e2e.ts --empty | --dump <before.json> | <manifest.json> <before.json>");
  process.exit(2);
}
if (args[0] !== "--dump") console.log(`\n${passed} checks passed${failed ? `, ${failed} failed` : ""}`);
// Timers the app modules start (sweeps, debounced work) would keep the process alive.
process.exit(failed ? 1 : 0);
