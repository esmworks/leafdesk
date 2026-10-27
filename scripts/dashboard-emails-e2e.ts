/**
 * End-to-end check of dashboard emails against the database and an SMTP server that keeps what it
 * gets (Mailpit): setting a subscription on a dashboard block (who may email whom), one round sent
 * by the scheduler for last week's figures with the change from the week before, each recipient's
 * email read with their own access, unsubscribing through the email's link, and a subscription
 * pausing when its dashboard is taken off the page. Creates its own users and workspace and deletes
 * them afterwards.
 *
 *   pnpm tsx scripts/dashboard-emails-e2e.ts
 *
 * Env: DATABASE_URL, APP_URL, BETTER_AUTH_SECRET, SMTP_URL (or SMTP_HOST) and MAIL_FROM pointed at
 * Mailpit, MAILPIT_URL (default http://localhost:8025). Read from .env when present. Migrations must
 * be applied, and no app server may run on the same database (its scheduler would take the round).
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { auditEvent, schedule, user, workspace, workspaceMember } = await import("@/db/schema");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");
const { addProperty, deleteProperty, getProperties } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { runDueSchedules } = await import("@/server/schedules");
const emails = await import("@/server/dashboard-emails");
const { DASHBOARD_BLOCK } = await import("@/lib/dashboard");

const RUN = `dashmail-e2e-${Date.now().toString(36)}`;
const MAILPIT = (process.env.MAILPIT_URL ?? "http://localhost:8025").replace(/\/$/, "");

const { service } = createCollab();
registerCollab(service);

let passed = 0;
function check(condition: unknown, label: string, detail?: unknown): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${label}`);
    if (detail !== undefined) console.error(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    throw new Error(`Check failed: ${label}`);
  }
  passed++;
  console.log(`ok    ${label}`);
}

async function rejects(work: Promise<unknown>, code: string) {
  try {
    await work;
    return false;
  } catch (error) {
    return (error as { code?: unknown }).code === code;
  }
}

/** Calls an MCP tool as `userId` with read and write access, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes: [READ_SCOPE, WRITE_SCOPE] });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: { id?: unknown; result?: { isError?: boolean; content: { text: string }[] } }[] = [];
  client.onmessage = (m) => void inbox.push(m as (typeof inbox)[number]);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dashboard-emails-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

type MailpitMessage = { ID: string; Subject: string; Text: string; HTML: string; To: { Address: string }[] };

/** The emails Mailpit holds for `to`, newest first. */
async function mailTo(to: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  if (!res.ok) throw new Error(`Mailpit answered ${res.status}`);
  const { messages } = (await res.json()) as { messages: { ID: string }[] };
  return Promise.all(messages.map(async (m) => (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as MailpitMessage));
}

async function headersOf(id: string): Promise<Record<string, string[]>> {
  return (await fetch(`${MAILPIT}/api/v1/message/${id}/headers`)).json() as Promise<Record<string, string[]>>;
}

const ids = { owner: `${RUN}-owner`, member: `${RUN}-member`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const email = (id: string) => `${id}@example.test`;
const workspaceId = `${RUN}-ws`;

try {
  await fetch(`${MAILPIT}/api/v1/info`).catch(() => {
    throw new Error(`Mailpit isn't answering at ${MAILPIT}`);
  });
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Person", email: email(ids.owner) },
    { id: ids.member, name: "Member Person", email: email(ids.member) },
    { id: ids.outsider, name: "Outsider Person", email: email(ids.outsider) },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: "Cold Rooms Ltd" });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
    { workspaceId, userId: ids.outsider, role: "member" },
  ]);
  const actor = { userId: ids.owner };

  // A report page the member may read and the outsider can't open, and a database of jobs under it.
  const report = await createPage(actor, { workspaceId, title: "Weekly report" });
  await setPagePermission(ids.owner, report.id, ids.owner, "full");
  await setPagePermission(ids.owner, report.id, null, "none");
  await setPagePermission(ids.owner, report.id, ids.member, "view");
  const jobs = await createPage(actor, { workspaceId, parentId: report.id, kind: "database", title: "Jobs" });
  for (const prop of await getProperties(jobs.id)) await deleteProperty(ids.owner, prop.id);
  await addProperty(ids.owner, jobs.id, { name: "Status", type: "select", options: ["Open", "Done"] });
  await addProperty(ids.owner, jobs.id, { name: "Amount", type: "number" });
  await addProperty(ids.owner, jobs.id, { name: "Finished", type: "date" });
  for (const [title, status, amount, finished] of [
    // Last week (Monday 19 to Sunday 25 October): three jobs, 600 in all.
    ["Freezer repair", "Done", 100, "2026-10-19"],
    ["Cold room install", "Done", 200, "2026-10-22"],
    ["Condenser swap", "Open", 300, "2026-10-25"],
    // The week before: two jobs, 250.
    ["Gasket change", "Done", 100, "2026-10-13"],
    ["Fan motor", "Done", 150, "2026-10-17"],
    // This week, after the email's period.
    ["Compressor", "Open", 999, "2026-10-26"],
  ] as const) {
    await createPage(actor, { workspaceId, parentId: jobs.id, title, properties: { Status: status, Amount: amount, Finished: finished } });
  }
  // A database only the owner can open.
  const salaries = await createPage(actor, { workspaceId, kind: "database", title: "Salaries" });
  await setPagePermission(ids.owner, salaries.id, ids.owner, "full");
  await setPagePermission(ids.owner, salaries.id, null, "none");

  const added = await callTool(ids.owner, "add_dashboard", {
    page_id: report.id,
    widgets: [
      { database_id: jobs.id, title: "Jobs", chart_type: "number" },
      { database_id: jobs.id, title: "Revenue", chart_type: "number", aggregate: "sum", aggregate_property: "Amount" },
      { database_id: jobs.id, title: "By status", type: "chart", group_by: "Status", aggregate: "sum", aggregate_property: "Amount" },
      { database_id: jobs.id, title: "Finished jobs", type: "list" },
      { database_id: salaries.id, title: "Payroll", chart_type: "number" },
    ],
  });
  check(!added.isError, "the dashboard is added", added.text);
  type Block = { id: string; type: string };
  const block = ((await getCollab().readBlocks(report.id)).blocks as Block[]).find((b) => b.type === DASHBOARD_BLOCK)!;
  const target = { block: block.id };
  const rule = { frequency: "weekly", interval: 1, weekdays: [1], time: "08:00", start: "2026-10-01" };
  const timeZone = "Europe/Istanbul";
  const setAt = new Date("2026-10-20T12:00:00Z");

  // Who may email whom
  check(
    await rejects(emails.setDashboardEmail(ids.member, report.id, target, { rule, timeZone, recipients: [ids.member, ids.owner] }, null, setAt), "needsEdit"),
    "emailing others takes edit access to the page",
  );
  check(
    await rejects(emails.setDashboardEmail(ids.owner, report.id, target, { rule, timeZone, recipients: [ids.outsider] }, null, setAt), "recipientNoAccess"),
    "only people who can open the page are named",
  );
  check(
    await rejects(emails.setDashboardEmail(ids.outsider, report.id, target, { rule, timeZone, recipients: [ids.outsider] }, null, setAt), "notFound"),
    "someone who can't open the page can't subscribe",
  );
  check(
    await rejects(emails.setDashboardEmail(ids.owner, report.id, { block: "missing" }, { rule, timeZone, recipients: [ids.owner] }, null, setAt), "notFound"),
    "a dashboard the page doesn't hold can't be subscribed to",
  );
  const own = await emails.setDashboardEmail(ids.member, report.id, target, { rule, timeZone, recipients: [ids.member] }, null, setAt);
  check(own.period === "last_week" && own.canChange && own.receives, "a reader subscribes themselves; a weekly email shows last week by default", own);
  await emails.removeDashboardEmail(ids.member, own.id);

  const set = await emails.setDashboardEmail(ids.owner, report.id, target, { rule, timeZone, recipients: [ids.owner, ids.member] }, null, setAt);
  check(set.nextRunAt === "2026-10-26T05:00:00.000Z" && set.recipients.length === 2, "the subscription is due Monday 08:00 in Istanbul", set);
  const listed = await emails.listDashboardEmails(ids.member, report.id, target);
  check(listed.length === 1 && !listed[0].canChange && listed[0].receives, "a recipient sees it, but changes it only through leaving", listed);
  check(await rejects(emails.removeDashboardEmail(ids.member, set.id), "needsEdit"), "a recipient can't stop it for everyone");
  const mine = await emails.myDashboardEmails(ids.member);
  check(mine.length === 1 && mine[0].title === "Weekly report", "Settings lists the subscriptions someone gets", mine);

  // One round, as the scheduler sends it
  const [scheduled] = await db.select().from(schedule).where(eq(schedule.id, set.id));
  await db.update(schedule).set({ nextRunAt: new Date("2026-10-26T05:00:00Z") }).where(eq(schedule.id, set.id));
  await runDueSchedules(new Date("2026-10-26T05:00:20Z"));
  const [afterRun] = await db.select().from(schedule).where(eq(schedule.id, set.id));
  check(afterRun.lastRunAt && !afterRun.lastError && afterRun.nextRunAt?.toISOString() === "2026-11-02T05:00:00.000Z", "the round ran and the next is a week on", afterRun);
  check(scheduled.kind === "dashboard_email", "stored as a dashboard_email schedule");

  let ownerMail: MailpitMessage[] = [];
  let memberMail: MailpitMessage[] = [];
  for (let i = 0; i < 50 && (!ownerMail.length || !memberMail.length); i++) {
    await new Promise((r) => setTimeout(r, 100));
    [ownerMail, memberMail] = await Promise.all([mailTo(email(ids.owner)), mailTo(email(ids.member))]);
  }
  check(ownerMail.length === 1 && memberMail.length === 1, "each recipient gets one email", { owner: ownerMail.length, member: memberMail.length });
  const [toOwner] = ownerMail;
  const [toMember] = memberMail;
  check(toOwner.Subject.startsWith("Weekly report: Last week"), "the subject names the dashboard and the period", toOwner.Subject);
  check(toOwner.Text.includes("Oct 19") || toOwner.Text.includes("19–25 Oct") || toOwner.Text.includes("19 – 25"), "the period's days are named", toOwner.Text);
  check(/Jobs: 3\b/.test(toOwner.Text) && toOwner.Text.includes("+50%"), "a count with its change from the week before", toOwner.Text);
  check(/Revenue: 600\b/.test(toOwner.Text) && toOwner.Text.includes("+140%"), "a sum over last week's rows with its change", toOwner.Text);
  check(toOwner.Text.includes("Done | 300") && toOwner.Text.includes("Open | 300"), "a chart comes as a table of its figures", toOwner.Text);
  check(toOwner.Text.includes("Freezer repair") && !toOwner.Text.includes("Compressor") && !toOwner.Text.includes("Gasket change"), "a list shows only the period's rows", toOwner.Text);
  check(/Payroll: 0\b/.test(toOwner.Text), "the owner sees the database only they can open", toOwner.Text);
  check(toMember.Text.includes("Payroll: You don't have access to this data."), "the member's email leaves out what they can't see", toMember.Text);
  check(toMember.Text.includes("Owner Person subscribed you"), "the email says who subscribed them", toMember.Text);
  check(toOwner.HTML.includes("▲ +140%") && toOwner.HTML.includes("#e6f4ea"), "a rise shows green in the HTML", toOwner.HTML.slice(0, 200));
  check(toOwner.HTML.includes(`/w/${workspaceId}/p/${report.id}`), "the email links back to the page");
  const headers = await headersOf(toMember.ID);
  const listUnsubscribe = headers["List-Unsubscribe"]?.[0] ?? "";
  check(listUnsubscribe.includes("/api/dashboard-emails/unsubscribe?token=") && headers["List-Unsubscribe-Post"]?.[0] === "List-Unsubscribe=One-Click", "mail apps get a one-click unsubscribe", headers);
  const audits = await db.select().from(auditEvent).where(and(eq(auditEvent.workspaceId, workspaceId), eq(auditEvent.action, "dashboard_email.sent")));
  check(audits.length === 1 && (audits[0].details as { count?: number }).count === 2, "the round is in the audit log", audits);

  // Unsubscribing through the email's link
  const link = /dashboard-emails\/unsubscribe\?token=([^\s"&]+)/.exec(toMember.Text)?.[1];
  check(link, "the email carries an unsubscribe link", toMember.Text);
  const token = decodeURIComponent(link);
  check((await emails.describeUnsubscribe(token))?.subscribed === true, "the unsubscribe page names the subscription");
  check(!(await emails.unsubscribeWithToken(`${token}x`)), "a changed token does nothing");
  check(await emails.unsubscribeWithToken(token), "the link unsubscribes");
  const [left] = await db.select().from(schedule).where(eq(schedule.id, set.id));
  check(JSON.stringify(left.settings.recipients) === JSON.stringify([ids.owner]), "only the member left", left.settings);
  check((await emails.describeUnsubscribe(token))?.subscribed === false, "the page then says they are off it");

  // A dashboard taken off its page pauses the subscription
  await getCollab().replaceContent(report.id, "Nothing here now", actor);
  await db.update(schedule).set({ nextRunAt: new Date("2026-11-02T05:00:00Z") }).where(eq(schedule.id, set.id));
  await runDueSchedules(new Date("2026-11-02T05:00:20Z"));
  const [paused] = await db.select().from(schedule).where(eq(schedule.id, set.id));
  check(!paused.enabled && paused.lastError === "dashboardGone", "a dashboard taken off its page pauses its emails", paused);
  check((await mailTo(email(ids.owner))).length === 1, "and sends nothing");

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId]));
  await db.delete(user).where(inArray(user.id, userIds));
  for (const id of userIds) await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email(id)}"`)}`, { method: "DELETE" }).catch(() => {});
  process.exit(process.exitCode ?? 0);
}
