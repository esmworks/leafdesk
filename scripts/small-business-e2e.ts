/**
 * End-to-end check of the small business kit of the built-in gallery. One call sets up a
 * dashboard, customers, quotes, jobs, a balance sheet and a weekly plan side by side in a
 * teamspace: the databases' properties and options, the relations between them (both ways), the
 * rollup and the formula, their views and default row templates, and the dashboard's widgets, all
 * on the kit's own properties, in every language. Rows added afterwards link up both ways and add
 * up in the rollup, the formula, the widgets and the home page's assigned rows. A kit that fails
 * halfway leaves nothing behind, a new workspace can start with it, MCP sets it up too, and a
 * guest can't. Creates its own users and workspaces and deletes them afterwards.
 *
 *   pnpm tsx scripts/small-business-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, asc, eq, inArray, isNull } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { databaseView, page, teamspace, user, workspace, workspaceMember } = await import("@/db/schema");
const { LOCALES } = await import("@/i18n/config");
const { builtinTemplate } = await import("@/lib/builtin-templates");
const { DASHBOARD_BLOCK, parseDashboard } = await import("@/lib/dashboard");
const { readPageStyle } = await import("@/lib/page-style");
const { holdsOptions } = await import("@/lib/property-types");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createRows, getProperties, getRow } = await import("@/server/databases");
const { widgetData } = await import("@/server/dashboards");
const { assignedRows } = await import("@/server/assigned");
const { createPage } = await import("@/server/pages");
const { createFromBuiltin, createWorkspaceWithBuiltin } = await import("@/server/templates");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
type BuiltinKitTemplate = import("@/lib/builtin-templates").BuiltinKitTemplate;
type BuiltinViewConfig = import("@/lib/builtin-templates").BuiltinViewConfig;
type BuiltinFilter = import("@/lib/builtin-templates").BuiltinFilter;
type ViewConfig = import("@/db/schema").ViewConfig;
type FilterEntry = import("@/db/schema").FilterEntry;
type Property = Awaited<ReturnType<typeof getProperties>>[number];

const RUN = `small-business-e2e-${Date.now().toString(36)}`;

const { hocuspocus, service } = createCollab();
registerCollab(service);

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

/** The error's code (or message), or null when it succeeds. */
async function failure(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
  }
}

/** The page's document as stored or, while open, live. */
async function withDoc<T>(pageId: string, fn: (doc: InstanceType<typeof Y.Doc>) => T): Promise<T> {
  const live = hocuspocus.documents.get(`page:${pageId}`);
  if (live) return fn(live);
  const [row] = await db.select({ ydoc: page.ydoc }).from(page).where(eq(page.id, pageId));
  const doc = new Y.Doc();
  if (row?.ydoc) Y.applyUpdate(doc, row.ydoc);
  try {
    return fn(doc);
  } finally {
    doc.destroy();
  }
}

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 2000; i++) {
      const hit = inbox.find((m) => m.id === id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no MCP response for ${name}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "small-business-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** `YYYY-MM-DD`, `days` from today (UTC, as widgets count without a time zone). */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const topLevel = (workspaceId: string) =>
  db.select().from(page).where(and(eq(page.workspaceId, workspaceId), isNull(page.parentId))).orderBy(asc(page.position));

// ── Comparing what was made with the kit ─────────────────────────────────────────────────────

/** What differs between view settings as the kit gives them (by names) and as stored (by ids). */
function configProblems(kit: BuiltinViewConfig, stored: ViewConfig, properties: Property[], where: string): string[] {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) problems.push(`${where}: ${what}`);
  };
  const nameOf = (id: unknown) => properties.find((p) => p.id === id)?.name;
  const { groupBy, stackBy, dateBy, chartAggregate, boardAggregate, sorts, filters, calculations, ...plain } = kit;
  const s = stored as Record<string, unknown>;
  for (const [key, name] of Object.entries({ groupBy, stackBy, dateBy })) {
    expect(name === undefined ? s[key] === undefined : nameOf(s[key]) === name, `${key} is ${nameOf(s[key]) ?? s[key]}, not ${name}`);
  }
  for (const [key, aggregate] of Object.entries({ chartAggregate, boardAggregate })) {
    const got = s[key] as { fn?: string; propertyId?: string } | undefined;
    expect(
      aggregate === undefined ? got === undefined : got?.fn === aggregate.fn && nameOf(got.propertyId) === aggregate.property,
      `${key} is ${JSON.stringify(got)}`,
    );
  }
  const storedSorts = stored.sorts ?? [];
  expect(
    storedSorts.length === (sorts ?? []).length && (sorts ?? []).every((sort, i) => nameOf(storedSorts[i]?.propertyId) === sort.property && storedSorts[i].direction === sort.direction),
    `sorts are ${JSON.stringify(storedSorts.map((x) => [nameOf(x.propertyId), x.direction]))}`,
  );
  const footers = Object.entries(stored.calculations ?? {}).map(([id, fn]) => [nameOf(id), fn]);
  expect(JSON.stringify(footers) === JSON.stringify(Object.entries(calculations ?? {})), `calculations are ${JSON.stringify(footers)}`);
  const sameFilters = (kitFilters: BuiltinFilter[], got: FilterEntry[] | undefined, path: string) => {
    expect((got ?? []).length === kitFilters.length, `${path}: ${got?.length ?? 0} filters, not ${kitFilters.length}`);
    kitFilters.forEach((filter, i) => {
      const entry = got?.[i];
      if (!entry) return;
      if ("combinator" in filter) {
        const ok = "type" in entry && entry.type === "group" && entry.combinator === filter.combinator;
        expect(ok, `${path}[${i}] isn't an "${filter.combinator}" group`);
        if (ok) sameFilters(filter.rules, entry.rules, `${path}[${i}]`);
        return;
      }
      if ("type" in entry) return expect(false, `${path}[${i}] is a group`);
      const prop = properties.find((p) => p.id === entry.propertyId);
      expect(prop?.name === filter.property && entry.op === filter.op && entry.days === filter.days, `${path}[${i}] is ${JSON.stringify(entry)}`);
      if (prop && holdsOptions(prop.type) && filter.value !== undefined) {
        const names = [entry.value].flat().map((id) => prop.options.options?.find((o) => o.id === id)?.name);
        expect(Array.isArray(entry.value) === Array.isArray(filter.value) && JSON.stringify(names) === JSON.stringify([filter.value].flat()), `${path}[${i}] holds ${JSON.stringify(names)}`);
      } else {
        expect(JSON.stringify(entry.value) === JSON.stringify(filter.value), `${path}[${i}] value is ${JSON.stringify(entry.value)}`);
      }
    });
  };
  sameFilters(filters ?? [], stored.filters, "filters");
  for (const [key, value] of Object.entries(plain)) expect(JSON.stringify(s[key]) === JSON.stringify(value), `${key} is ${JSON.stringify(s[key])}`);
  return problems;
}

/**
 * Everything that differs between a kit as made (its parts, in order) and the kit itself: parts,
 * properties with their options, relations, rollups and formulas, views, row templates and the
 * dashboard. Empty when they match.
 */
async function kitProblems(kit: BuiltinKitTemplate, partIds: string[]): Promise<string[]> {
  const problems: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  if (partIds.length !== kit.parts.length) return [`${partIds.length} parts, not ${kit.parts.length}`];
  const idOf = new Map(kit.parts.map((part, i) => [part.key, partIds[i]]));
  const rows = await db.select().from(page).where(inArray(page.id, partIds));
  const propertiesOf = new Map<string, Property[]>();
  for (const part of kit.parts) if (part.kind === "database") propertiesOf.set(part.key, await getProperties(idOf.get(part.key)!));

  for (const [i, part] of kit.parts.entries()) {
    const made = rows.find((r) => r.id === partIds[i]);
    expect(made?.kind === part.kind && made.title === part.title && made.icon === part.icon && !made.archivedAt, `${part.key} is ${JSON.stringify(made && [made.kind, made.title, made.icon])}`);
    if (part.kind !== "database") continue;
    const databaseId = idOf.get(part.key)!;
    const properties = propertiesOf.get(part.key)!;
    expect(new Set(properties.map((p) => p.name)).size === properties.length, `${part.key} has a property name twice`);
    for (const kitProperty of part.properties) {
      const where = `${part.key}.${kitProperty.name}`;
      const prop = properties.find((p) => p.name === kitProperty.name);
      if (!prop) {
        expect(false, `${where} is missing`);
        continue;
      }
      expect(prop.type === kitProperty.type, `${where} is a ${prop.type}`);
      if (kitProperty.options) {
        const options = prop.options.options ?? [];
        expect(JSON.stringify(options.map((o) => o.name)) === JSON.stringify(kitProperty.options.map((o) => o.name)), `${where} has ${options.map((o) => o.name)}`);
        for (const option of kitProperty.options) {
          const got = options.find((o) => o.name === option.name);
          if (option.group) expect(got?.group === option.group, `${where} "${option.name}" is in ${got?.group}`);
          if (option.color) expect(got?.color === option.color, `${where} "${option.name}" is ${got?.color}`);
        }
      }
      if (kitProperty.number) expect(JSON.stringify(prop.options.number) === JSON.stringify(kitProperty.number), `${where} shows ${JSON.stringify(prop.options.number)}`);
      if (kitProperty.relation) {
        const target = idOf.get(kitProperty.relation.database)!;
        const paired = propertiesOf.get(kitProperty.relation.database)!.find((p) => p.id === prop.options.relation?.pairedPropertyId);
        expect(prop.options.relation?.databaseId === target, `${where} links to ${prop.options.relation?.databaseId}`);
        expect(
          paired?.name === kitProperty.relation.pairedName && paired.type === "relation" && paired.options.relation?.databaseId === databaseId && paired.options.relation.pairedPropertyId === prop.id,
          `${where} pairs with ${JSON.stringify(paired && [paired.name, paired.options.relation])}`,
        );
      }
      if (kitProperty.rollup) {
        const { relation, target, fn } = kitProperty.rollup;
        const through = properties.find((p) => p.name === relation);
        const related = [...propertiesOf.entries()].find(([key]) => idOf.get(key) === through?.options.relation?.databaseId)?.[1];
        expect(
          prop.options.rollup?.relationPropertyId === through?.id &&
            prop.options.rollup?.targetPropertyId === related?.find((p) => p.name === target)?.id &&
            prop.options.rollup?.function === fn,
          `${where} rolls up ${JSON.stringify(prop.options.rollup)}`,
        );
      }
      if (kitProperty.formula !== undefined) expect(prop.options.formula?.type === "number", `${where} gives ${prop.options.formula?.type}`);
    }

    const views = await db.select().from(databaseView).where(eq(databaseView.databaseId, databaseId)).orderBy(asc(databaseView.position));
    expect(JSON.stringify(views.map((v) => [v.name, v.type])) === JSON.stringify(part.views.map((v) => [v.name, v.type])), `${part.key} has views ${views.map((v) => v.name)}`);
    for (const [j, view] of part.views.entries()) if (views[j]) problems.push(...configProblems(view.config, views[j].config, properties, `${part.key} view "${view.name}"`));

    const children = await db.select().from(page).where(eq(page.parentId, databaseId));
    expect(children.filter((c) => !c.isTemplate).length === 0, `${part.key} has rows`);
    const templates = children.filter((c) => c.isTemplate);
    if (part.rowTemplate) {
      const [template] = templates;
      expect(templates.length === 1 && made?.defaultTemplateId === template.id && template.title === part.rowTemplate.title, `${part.key}'s row template is ${JSON.stringify(templates.map((t) => t.title))}`);
      for (const [name, value] of Object.entries(part.rowTemplate.properties)) {
        const prop = properties.find((p) => p.name === name);
        const option = prop?.options.options?.find((o) => o.id === template?.properties[prop.id]);
        expect(option?.name === value, `${part.key}'s row template sets ${name} to ${option?.name}`);
      }
    } else expect(templates.length === 0, `${part.key} has row templates`);
  }

  for (const [i, part] of kit.parts.entries()) {
    if (part.kind !== "page") continue;
    const { markdown } = await service.readPage(partIds[i]);
    const firstLine = part.markdown.split("\n").find((line) => line.trim() && !line.startsWith(">"));
    expect(!!firstLine && markdown.includes(firstLine.replace(/^#+\s*/, "").trim()), `${part.key}'s body is ${JSON.stringify(markdown.slice(0, 200))}`);
    if (!part.dashboard) continue;
    const { blocks } = await service.readBlocks(partIds[i]);
    const block = (blocks as { type: string; props: Record<string, string> }[]).find((b) => b.type === DASHBOARD_BLOCK);
    const widgets = parseDashboard(block?.props.widgets);
    expect(widgets.length === part.dashboard.length, `${part.key} has ${widgets.length} widgets, not ${part.dashboard.length}`);
    for (const [j, kitWidget] of part.dashboard.entries()) {
      const widget = widgets[j];
      if (!widget) continue;
      const where = `widget "${kitWidget.title}"`;
      expect(
        widget.databaseId === idOf.get(kitWidget.database) && widget.title === kitWidget.title && widget.span === kitWidget.span && widget.color === kitWidget.color && widget.view.type === kitWidget.view.type,
        `${where} is ${JSON.stringify({ ...widget, view: widget.view.type })}`,
      );
      problems.push(...configProblems(kitWidget.view.config, widget.view.config, propertiesOf.get(kitWidget.database)!, where));
    }
    const style = await withDoc(partIds[i], (doc) => readPageStyle(doc));
    expect(style.fullWidth, `${part.key} isn't full width`);
  }
  return problems;
}

const ids = { owner: `${RUN}-owner`, guest: `${RUN}-guest` };
const workspaceId = `${RUN}-ws`;
const madeWorkspaces: string[] = [];

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Oya", email: `${ids.owner}@example.test` },
    { id: ids.guest, name: "Guest Gül", email: `${ids.guest}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.guest, role: "guest" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };

  // ── In Turkish: the parts, side by side in the teamspace ─────────────────────────────────────
  const tr = (await builtinTemplate("small-business", "tr")) as BuiltinKitTemplate;
  const made = await createFromBuiltin(owner, workspaceId, "small-business", { locale: "tr", teamspaceId: general.id });
  const parts = made.parts ?? [];
  check(
    JSON.stringify(parts.map((p) => [p.title, p.kind])) ===
      JSON.stringify([
        ["Gösterge Paneli", "page"],
        ["Müşteriler", "database"],
        ["Verilen Teklifler", "database"],
        ["İşlerim", "database"],
        ["Bilanço", "database"],
        ["Haftalık plan", "page"],
      ]) && made.id === parts[0].id,
    "the kit makes the dashboard, four databases and the weekly plan, and opens the dashboard",
    parts,
  );
  const sidebar = await topLevel(workspaceId);
  check(
    JSON.stringify(sidebar.map((p) => p.id)) === JSON.stringify(parts.map((p) => p.id)) && sidebar.every((p) => p.teamspaceId === general.id),
    "…side by side at the top of the teamspace, in that order",
    sidebar.map((p) => [p.title, p.teamspaceId]),
  );
  const problems = await kitProblems(tr, parts.map((p) => p.id));
  check(problems.length === 0, "every property, option, relation, rollup, formula, view, row template and widget is as the kit says", problems);

  const [, customersId, quotesId, jobsId, balanceId] = parts.map((p) => p.id);
  const props = async (databaseId: string) => new Map((await getProperties(databaseId)).map((p) => [p.name, p]));
  const [c, q, j, b] = await Promise.all([customersId, quotesId, jobsId, balanceId].map(props));
  check(
    JSON.stringify([...c.values()].map((p) => [p.name, p.type])) ===
      JSON.stringify([
        ["Aşama", "select"],
        ["Şehir", "select"],
        ["Yetkili kişi", "text"],
        ["Telefon", "phone"],
        ["E-posta", "email"],
        ["Sonraki adım", "text"],
        ["Sonraki adım tarihi", "date"],
        ["Teklifler", "relation"],
        ["İşler", "relation"],
        ["Teklif toplamı", "rollup"],
      ]),
    "customers: stage, city, contact, next step, and the quotes and jobs that link to them, with their total",
    [...c.values()].map((p) => [p.name, p.type]),
  );
  check(
    JSON.stringify([...q.values()].map((p) => [p.name, p.type])) ===
      JSON.stringify([
        ["Müşteri", "relation"],
        ["Durum", "status"],
        ["Tutar", "number"],
        ["Takip tarihi", "date"],
        ["Teklif tarihi", "date"],
        ["Son geçerlilik", "date"],
        ["Hazırlayan", "person"],
        ["İşler", "relation"],
      ]) &&
      JSON.stringify(q.get("Durum")!.options.options!.map((o) => [o.name, o.group])) ===
        JSON.stringify([
          ["Taslak", "todo"],
          ["Gönderildi", "in_progress"],
          ["Revizyon istendi", "in_progress"],
          ["Kabul edildi", "done"],
          ["Kaybedildi", "done"],
        ]) &&
      q.get("Tutar")!.options.number?.currency === "TRY",
    "quotes: customer, status from draft to accepted or lost, an amount in lira, dates and who prepared it",
    [...q.values()].map((p) => [p.name, p.type, p.options.options?.map((o) => o.name)]),
  );
  check(
    JSON.stringify([...j.values()].map((p) => [p.name, p.type])) ===
      JSON.stringify([
        ["Durum", "status"],
        ["Öncelik", "select"],
        ["Sorumlu", "person"],
        ["Teslim tarihi", "date"],
        ["Müşteri", "relation"],
        ["Teklif", "relation"],
        ["Notlar", "text"],
      ]),
    "jobs: status, priority, the person on it, due date, customer and quote",
    [...j.values()].map((p) => [p.name, p.type]),
  );
  check(
    JSON.stringify([...b.values()].map((p) => [p.name, p.type])) ===
      JSON.stringify([
        ["Tarih", "date"],
        ["Taraf", "select"],
        ["Grup", "select"],
        ["Tutar", "number"],
        ["Net etki", "formula"],
        ["Not", "text"],
      ]) && b.get("Grup")!.options.options!.length === 12,
    "balance sheet: date, asset or liability, twelve groups, amount and its net effect",
    [...b.values()].map((p) => [p.name, p.type]),
  );
  check(
    q.get("Müşteri")!.options.relation?.pairedPropertyId === c.get("Teklifler")!.id &&
      j.get("Müşteri")!.options.relation?.pairedPropertyId === c.get("İşler")!.id &&
      j.get("Teklif")!.options.relation?.pairedPropertyId === q.get("İşler")!.id,
    "quotes and jobs link to customers, and jobs to quotes, both ways",
  );

  // ── Rows link up and add up ──────────────────────────────────────────────────────────────────
  const [ege, deniz] = await createRows(ids.owner, customersId, [
    { title: "Ege Gıda", properties: { Aşama: "Müşteri", "Sonraki adım": "Fiyat listesini gönder", "Sonraki adım tarihi": day(1) } },
    { title: "Deniz Otel", properties: { Aşama: "Aday" } },
  ]);
  const [sent, accepted] = await createRows(ids.owner, quotesId, [
    { title: "Soğuk oda", properties: { Müşteri: [ege.id], Durum: "Gönderildi", Tutar: 120000, "Takip tarihi": day(-1), "Teklif tarihi": day(-10), Hazırlayan: [ids.owner] } },
    { title: "Bakım sözleşmesi", properties: { Müşteri: [ege.id], Durum: "Kabul edildi", Tutar: 30000, "Teklif tarihi": day(-20) } },
    { title: "Klima", properties: { Müşteri: [deniz.id], Durum: "Kaybedildi", Tutar: 5000 } },
  ]);
  const [late, soon] = await createRows(ids.owner, jobsId, [
    { title: "Montaj", properties: { Durum: "Devam ediyor", Öncelik: "Acil", Sorumlu: [ids.owner], "Teslim tarihi": day(-2), Müşteri: [ege.id], Teklif: [accepted.id] } },
    { title: "Keşif", properties: { Durum: "Yapılacak", Öncelik: "Normal", Sorumlu: [ids.owner], "Teslim tarihi": day(5), Müşteri: [ege.id] } },
    { title: "Eski iş", properties: { Durum: "Tamamlandı", Sorumlu: [ids.owner], "Teslim tarihi": day(-3), Müşteri: [deniz.id] } },
  ]);
  const thisMonth = day(0);
  const earlier = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
  })();
  const [cash, , owed] = await createRows(ids.owner, balanceId, [
    { title: "Banka", properties: { Tarih: thisMonth, Taraf: "Varlık", Grup: "Kasa ve banka", Tutar: 50000 } },
    { title: "Ege Gıda alacağı", properties: { Tarih: thisMonth, Taraf: "Varlık", Grup: "Müşteri alacakları", Tutar: 30000 } },
    { title: "Tedarikçi", properties: { Tarih: thisMonth, Taraf: "Borç", Grup: "Tedarikçi borçları", Tutar: 20000 } },
    { title: "Geçen ayın kasası", properties: { Tarih: earlier, Taraf: "Varlık", Grup: "Kasa ve banka", Tutar: 99999 } },
  ]);

  const egeRow = (await getRow(ids.owner, ege.id)).row.properties;
  check(
    JSON.stringify(egeRow[c.get("Teklifler")!.id]) === JSON.stringify([sent.id, accepted.id]) &&
      JSON.stringify(egeRow[c.get("İşler")!.id]) === JSON.stringify([late.id, soon.id]) &&
      egeRow[c.get("Teklif toplamı")!.id] === 150000,
    "a customer shows its quotes and jobs, and the total it was quoted",
    egeRow,
  );
  const acceptedRow = (await getRow(ids.owner, accepted.id)).row.properties;
  check(JSON.stringify(acceptedRow[q.get("İşler")!.id]) === JSON.stringify([late.id]), "a quote shows the jobs made from it", acceptedRow);
  const net = async (id: string) => (await getRow(ids.owner, id)).row.properties[b.get("Net etki")!.id];
  check((await net(cash.id)) === 50000 && (await net(owed.id)) === -20000, "what is owed counts against the net worth", [await net(cash.id), await net(owed.id)]);

  const [dashboardBlock] = ((await service.readBlocks(parts[0].id)).blocks as { type: string; props: Record<string, string> }[]).filter((x) => x.type === DASHBOARD_BLOCK);
  const widgets = parseDashboard(dashboardBlock.props.widgets);
  const data = await Promise.all(widgets.map((w) => widgetData(owner, w)));
  check(data.every((d) => d.state === "ok"), "every widget works out", data.map((d) => d.state));
  const [openJobs, dueJobs, openQuotes, netWorth, jobsByPerson, upcomingJobs, quotesByStatus, quoteFollowUps, customersByStage, customerFollowUps, balanceBreakdown, netWorthByDate] =
    data;
  const count = (d: (typeof data)[number]) => (d.state === "ok" ? d.rowCount : -1);
  const value = (d: (typeof data)[number]) => (d.state === "ok" && d.kind === "number" ? d.result?.value : undefined);
  const listed = (d: (typeof data)[number]) => (d.state === "ok" && d.kind === "list" ? d.rows.map((r) => r.title) : []);
  const total = (d: (typeof data)[number]) => (d.state === "ok" && d.kind === "chart" ? d.chart?.total : undefined);
  check(count(openJobs) === 2 && count(dueJobs) === 1 && count(openQuotes) === 1, "the numbers count open jobs, those due or late, and open quotes", [count(openJobs), count(dueJobs), count(openQuotes)]);
  check(value(netWorth) === 60000, "the net worth adds up this month's entries, what is owed taken off", netWorth);
  check(total(jobsByPerson) === 2 && total(quotesByStatus) === 3 && total(customersByStage) === 2, "the charts count open jobs, all quotes and all customers", [total(jobsByPerson), total(quotesByStatus), total(customersByStage)]);
  check(JSON.stringify(listed(upcomingJobs)) === JSON.stringify(["Montaj", "Keşif"]), "open jobs are listed by due date, the late one first", upcomingJobs);
  check(JSON.stringify(listed(quoteFollowUps)) === JSON.stringify(["Soğuk oda"]) && JSON.stringify(listed(customerFollowUps)) === JSON.stringify(["Ege Gıda"]), "quotes and customers to follow up are listed", [quoteFollowUps, customerFollowUps]);
  check(total(balanceBreakdown) === 100000, "the balance sheet this month breaks down this month's entries only", balanceBreakdown);
  check(
    netWorthByDate.state === "ok" && netWorthByDate.kind === "chart" && netWorthByDate.chart?.groups.filter((g) => g.amount !== 0).length === 2 && netWorthByDate.chart.total === 159999,
    "the net worth by date has one bar per day counted",
    netWorthByDate,
  );
  const assigned = (await assignedRows(ids.owner, workspaceId, day(0))).groups.flatMap((g) => g.rows);
  const assignedOn = new Map(assigned.map((r) => [r.title, r.date]));
  check(
    assignedOn.get("Soğuk oda") === day(-1) && assignedOn.get("Montaj") === day(-2) && assignedOn.get("Keşif") === day(5) && !assignedOn.has("Eski iş"),
    "the home page lists a quote by its follow-up and open jobs by their due date for the person on them",
    assigned.map((r) => [r.title, r.date]),
  );

  // ── Every language ───────────────────────────────────────────────────────────────────────────
  for (const locale of LOCALES) {
    const kit = (await builtinTemplate("small-business", locale)) as BuiltinKitTemplate;
    const inLocale = await createFromBuiltin(owner, workspaceId, "small-business", { locale, teamspaceId: general.id });
    const found = await kitProblems(kit, (inLocale.parts ?? []).map((p) => p.id));
    check(found.length === 0, `${locale}: the kit is made on its own names (${kit.parts.map((p) => p.title).join(", ")})`, found);
  }

  // ── Under a page, never in a database ────────────────────────────────────────────────────────
  const host = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Şirket" });
  const nested = await createFromBuiltin(owner, workspaceId, "small-business", { locale: "en", parentId: host.id });
  const under = await db.select({ id: page.id, parentId: page.parentId }).from(page).where(inArray(page.id, (nested.parts ?? []).map((p) => p.id)));
  check(under.length === 6 && under.every((p) => p.parentId === host.id), "under a page, the parts go inside it");
  const pagesNow = async () => (await db.select({ id: page.id }).from(page).where(eq(page.workspaceId, workspaceId))).length;
  const before = await pagesNow();
  check((await failure(createFromBuiltin(owner, workspaceId, "small-business", { parentId: customersId }))) === "nestedDatabase", "a database can't take the kit");
  check((await pagesNow()) === before, "…and nothing is made");

  // ── A kit that fails halfway leaves nothing behind ───────────────────────────────────────────
  const appendBlocks = service.appendBlocks;
  service.appendBlocks = async () => {
    throw new Error("The dashboard couldn't be saved");
  };
  try {
    const known = new Set((await topLevel(workspaceId)).map((p) => p.id));
    const why = await failure(createFromBuiltin(owner, workspaceId, "small-business", { locale: "tr", teamspaceId: general.id }));
    const left = (await topLevel(workspaceId)).filter((p) => !known.has(p.id));
    check(why === "The dashboard couldn't be saved" && left.length === 6 && left.every((p) => p.archivedAt), "when the dashboard can't be added, the parts made go to the trash", left.map((p) => [p.title, p.archivedAt]));

    // A new workspace keeps its name even when its template couldn't be set up.
    const empty = await createWorkspaceWithBuiltin(ids.owner, `${RUN} empty`, "small-business", { locale: "tr" });
    madeWorkspaces.push(empty.workspaceId);
    check(empty.pageId === null && (await topLevel(empty.workspaceId)).every((p) => p.archivedAt), "a new workspace is made, empty, when its template fails", empty);
  } finally {
    service.appendBlocks = appendBlocks;
  }

  // ── A new workspace that starts with the kit ─────────────────────────────────────────────────
  const fresh = await createWorkspaceWithBuiltin(ids.owner, `${RUN} fresh`, "small-business", { locale: "tr" });
  madeWorkspaces.push(fresh.workspaceId);
  const freshTop = await topLevel(fresh.workspaceId);
  const [freshGeneral] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, fresh.workspaceId));
  const [membership] = await db.select().from(workspaceMember).where(and(eq(workspaceMember.workspaceId, fresh.workspaceId), eq(workspaceMember.userId, ids.owner)));
  check(
    membership?.role === "owner" &&
      fresh.pageId === freshTop[0]?.id &&
      JSON.stringify(freshTop.map((p) => p.title)) === JSON.stringify(tr.parts.map((p) => p.title)) &&
      freshTop.every((p) => p.teamspaceId === freshGeneral.id),
    "a new workspace starts with the kit in its general teamspace, and opens on the dashboard",
    freshTop.map((p) => [p.title, p.teamspaceId]),
  );
  const freshProblems = await kitProblems(tr, freshTop.map((p) => p.id));
  check(freshProblems.length === 0, "…complete", freshProblems);
  check(
    (await failure(createWorkspaceWithBuiltin(ids.owner, `${RUN} nope`, "nope" as never))) === "notATemplate" &&
      (await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.name, `${RUN} nope`))).length === 0,
    "an unknown template makes no workspace",
  );

  // ── MCP ──────────────────────────────────────────────────────────────────────────────────────
  const listedTemplates = await callTool(ids.owner, "list_templates", { workspace_id: workspaceId });
  const entry = listedTemplates.data?.built_in.find((t: { id: string }) => t.id === "builtin:small-business");
  check(entry?.kind === "kit" && entry.title === "Small business", "list_templates offers the kit", listedTemplates.text);
  const viaMcp = await callTool(ids.owner, "create_page", { workspace_id: workspaceId, teamspace_id: general.id, template_id: "builtin:small-business" });
  check(
    !viaMcp.isError &&
      viaMcp.data.id === viaMcp.data.parts?.[0]?.id &&
      JSON.stringify(viaMcp.data.parts.map((p: { title: string; kind: string }) => [p.title, p.kind])) ===
        JSON.stringify([
          ["Dashboard", "page"],
          ["Customers", "database"],
          ["Quotes", "database"],
          ["Jobs", "database"],
          ["Balance sheet", "database"],
          ["Weekly plan", "page"],
        ]),
    "create_page sets up the kit and lists its parts",
    viaMcp.text,
  );
  const en = (await builtinTemplate("small-business", "en")) as BuiltinKitTemplate;
  const mcpProblems = await kitProblems(en, viaMcp.data.parts.map((p: { id: string }) => p.id));
  check(mcpProblems.length === 0, "…complete", mcpProblems);
  const titled = await callTool(ids.owner, "create_page", { workspace_id: workspaceId, teamspace_id: general.id, template_id: "builtin:small-business", title: "Shop" });
  check(titled.isError && titled.text.includes("leave out title"), "a title for a kit is refused before anything is made", titled.text);

  // ── A guest can't set it up ──────────────────────────────────────────────────────────────────
  const count0 = await pagesNow();
  check((await failure(createFromBuiltin({ userId: ids.guest }, workspaceId, "small-business", { teamspaceId: general.id }))) !== null, "a guest can't set up the kit");
  check((await pagesNow()) === count0, "…and nothing is made");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, ...madeWorkspaces]));
  await db.delete(user).where(inArray(user.id, Object.values(ids)));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
