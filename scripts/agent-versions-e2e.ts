/**
 * End-to-end check of versions of an agent's setup against the database: making an agent, changing
 * its settings, skills, schedules and the pages shared with it each keep a version; a person's saves
 * within two minutes of each other make one, someone else's or a later one a new one, a save that
 * changes nothing none; an agent keeps its last 50; owners (only) see how a version differs from now
 * and bring it back: settings, skills, schedules and shares as they were, pages deleted or in the
 * trash since and settings no longer valid skipped and listed, a version and an audit entry made; an
 * archived agent can't be; the baseline the migration makes for agents made before reads as the app
 * reads a setup; sharing a page with the agent from the page's Share menu counts, an automation
 * sharing its database with it doesn't.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/agent-versions-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { readFileSync } = await import("node:fs");
const { asc, eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { agentSkill, agentVersion, auditEvent, schedule, teamspace, user, workspace, workspaceAgent, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { archivePage, createPage } = await import("@/server/pages");
const { setPagePermission } = await import("@/server/permissions");
const { setSkill } = await import("@/server/skills");
const agents = await import("@/server/agents/manage");
const { addAgentSkill, removeAgentSkill } = await import("@/server/agents/skills");
const { setAgentSchedule } = await import("@/server/agents/schedules");
const { readSnapshot } = await import("@/server/agents/version-record");
const { getAgentVersion, listAgentVersions, restoreAgentVersion } = await import("@/server/agents/versions");
const { MAX_AGENT_VERSIONS, parseSnapshot, sameSnapshot } = await import("@/lib/agent-versions");

const RUN = `agent-versions-e2e-${Date.now().toString(36)}`;

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

/** The AgentError code a promise fails with ("" when it doesn't fail, or fails otherwise). */
async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof agents.AgentError ? error.code : `other: ${String(error)}`;
  }
}

const ids = { owner: `${RUN}-owner`, other: `${RUN}-other`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const ZONE = "Europe/Istanbul";
const daily = { frequency: "daily", interval: 1, weekdays: [], time: "08:00" };

const versionsOf = async (agentId: string) =>
  db.select().from(agentVersion).where(eq(agentVersion.agentId, agentId)).orderBy(asc(agentVersion.number));
/** Takes the agent's latest version out of the merge window, as if saved minutes ago. */
async function age(agentId: string) {
  await db
    .update(agentVersion)
    .set({ updatedAt: sql`${agentVersion.updatedAt} - interval '5 minutes'` })
    .where(eq(agentVersion.agentId, agentId));
}
const rowOf = async (agentId: string) => (await db.select().from(workspaceAgent).where(eq(workspaceAgent.id, agentId)))[0];

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner Olcay", email: `${ids.owner}@example.test` },
    { id: ids.other, name: "Owner Oya", email: `${ids.other}@example.test` },
    { id: ids.member, name: "Member Mert", email: `${ids.member}@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.other, role: "owner" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  const [general] = await db.select({ id: teamspace.id }).from(teamspace).where(eq(teamspace.workspaceId, workspaceId));
  const owner = { userId: ids.owner };
  const tickets = await createPage(owner, { workspaceId, teamspaceId: general.id, kind: "database", title: "Tickets" });
  const handbook = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Handbook" });
  const pricing = await createPage(owner, { workspaceId, teamspaceId: general.id, title: "Pricing" });
  // Skills only owners may edit: private pages of the owner.
  const triage = await createPage(owner, { workspaceId, teamspaceId: null, title: "Triage rules", markdown: "Refunds are Billing." });
  await setSkill(ids.owner, triage.id, { skill: true });
  const tone = await createPage(owner, { workspaceId, teamspaceId: null, title: "Tone", markdown: "Be kind." });
  await setSkill(ids.owner, tone.id, { skill: true });

  // ── Saving makes versions ───────────────────────────────────────────────────────────────────
  const router = await agents.createAgent(ids.owner, workspaceId, { name: "Ticket router", instructions: "Sort new tickets.\nBe brief." });
  let versions = await versionsOf(router.id);
  check(versions.length === 1 && versions[0].number === 1 && versions[0].kind === "created" && versions[0].createdBy === ids.owner, "making an agent keeps version 1, as made", versions);
  const created = parseSnapshot(versions[0].snapshot);
  check(
    created.settings.name === "Ticket router" && created.settings.instructions === "Sort new tickets.\nBe brief." && created.settings.enabled === true && !("id" in created.settings) && !("archived_at" in created.settings),
    "…with its settings by column, without its ids, times or archiving",
    created.settings,
  );

  await agents.updateAgent(ids.owner, router.id, { instructions: "Sort new tickets.\nBe very brief.\nAsk when unsure." });
  versions = await versionsOf(router.id);
  check(versions.length === 2 && versions[1].kind === "changed" && JSON.stringify(versions[1].changes) === '["instructions"]', "changing its instructions keeps version 2, naming what changed", versions.map((v) => v.changes));

  await addAgentSkill(ids.owner, router.id, triage.id);
  const weekly = await setAgentSchedule(ids.owner, router.id, null, { rule: daily, timeZone: ZONE, task: "Go through open tickets", databaseId: tickets.id });
  await agents.setAgentAccess(ids.owner, router.id, handbook.id, "view");
  await agents.setAgentAccess(ids.owner, router.id, pricing.id, "comment");
  versions = await versionsOf(router.id);
  check(
    versions.length === 2 && JSON.stringify(versions[1].changes) === '["instructions","skills","schedules","shares"]',
    "the same owner's saves within two minutes add to that version: skill, schedule and shares",
    versions.map((v) => v.changes),
  );
  const v2 = parseSnapshot(versions[1].snapshot);
  check(
    JSON.stringify(v2.skills) === JSON.stringify([triage.id]) &&
      v2.schedules.length === 1 &&
      v2.schedules[0].id === weekly.id &&
      v2.schedules[0].task === "Go through open tickets" &&
      v2.schedules[0].databaseId === tickets.id &&
      v2.shares.length === 2 &&
      v2.shares.some((s) => s.pageId === handbook.id && s.level === "view"),
    "a version keeps the skills, the schedules as set and the pages shared, with their levels",
    v2,
  );

  await agents.updateAgent(ids.other, router.id, { description: "Routes tickets" });
  versions = await versionsOf(router.id);
  check(versions.length === 3 && versions[2].createdBy === ids.other && JSON.stringify(versions[2].changes) === '["description"]', "another owner's save makes a version of its own");

  await agents.updateAgent(ids.other, router.id, { description: "Routes tickets" });
  await addAgentSkill(ids.owner, router.id, triage.id);
  check((await versionsOf(router.id)).length === 3, "a save that changes nothing makes no version");

  await age(router.id);
  await agents.updateAgent(ids.other, router.id, { enabled: false });
  versions = await versionsOf(router.id);
  check(versions.length === 4 && JSON.stringify(versions[3].changes) === '["enabled"]', "the same owner's save after two minutes makes a new version");

  await agents.updateAgent(ids.other, router.id, { enabled: true });
  versions = await versionsOf(router.id);
  check(versions.length === 3, "changing back within the window leaves nothing of that version", versions.map((v) => v.number));

  // ── Who sees them ───────────────────────────────────────────────────────────────────────────
  check((await codeOf(listAgentVersions(ids.member, router.id))) === "notFound", "members can't list an agent's versions");
  check((await codeOf(getAgentVersion(ids.member, router.id, 1))) === "notFound", "…or see one");
  check((await codeOf(restoreAgentVersion(ids.member, router.id, 1))) === "notFound", "…or restore one");
  check((await codeOf(getAgentVersion(ids.owner, router.id, 99))) === "versionNotFound", "a version it doesn't have isn't found");

  const listed = await listAgentVersions(ids.owner, router.id);
  check(
    listed.map((v) => v.number).join() === "3,2,1" && listed[0].by?.name === "Owner Oya" && listed[2].kind === "created" && !("snapshot" in listed[0]),
    "owners list the versions newest first, with who saved them and without their setups",
    listed,
  );

  const first = await getAgentVersion(ids.owner, router.id, 1);
  const instructions = first.settings.find((s) => s.field === "instructions");
  check(
    instructions?.before === "Sort new tickets.\nBe brief." &&
      instructions.after === "Sort new tickets.\nBe very brief.\nAsk when unsure." &&
      first.settings.some((s) => s.field === "description" && s.before === "" && s.after === "Routes tickets") &&
      first.skills.added.map((s) => s.title).join() === "Triage rules" &&
      first.schedules.added.length === 1 &&
      first.schedules.added[0].database?.title === "Tickets" &&
      first.shares.added.map((s) => `${s.title}:${s.level}`).sort().join() === "Handbook:view,Pricing:comment",
    "a version shows what changed from it to now: instructions, other settings, skills, schedules, pages",
    first,
  );

  // ── Restoring ───────────────────────────────────────────────────────────────────────────────
  await age(router.id);
  const back = await restoreAgentVersion(ids.owner, router.id, 1);
  const afterFirst = await rowOf(router.id);
  const [botUser] = await db.select({ name: user.name }).from(user).where(eq(user.id, afterFirst.userId));
  check(back.skipped.length === 0 && back.version.number === 4 && back.version.kind === "restored" && back.version.restoredFrom === 1, "restoring version 1 makes version 4, saying which it brought back", back);
  check(
    afterFirst.instructions === "Sort new tickets.\nBe brief." && afterFirst.description === "" && afterFirst.name === "Ticket router" && botUser.name === "Ticket router",
    "…its settings are as they were",
    afterFirst,
  );
  const now = await readSnapshot(afterFirst);
  check(now.skills.length === 0 && now.schedules.length === 0 && now.shares.length === 0, "…its skill, schedule and pages are gone again", now);
  check(sameSnapshot(now, created), "…the whole setup is version 1's");
  const audit = await db.select({ action: auditEvent.action, details: auditEvent.details }).from(auditEvent).where(eq(auditEvent.workspaceId, workspaceId));
  check(
    audit.some((a) => a.action === "agent.updated" && (a.details as { restoredVersion?: number }).restoredVersion === 1) && audit.some((a) => a.action === "agent.schedule_removed"),
    "…and the audit log records the restore and what it changed",
    audit.map((a) => a.action),
  );

  await agents.updateAgent(ids.owner, router.id, { name: "Ticket router 2" });
  versions = await versionsOf(router.id);
  check(versions.length === 5 && versions[4].kind === "changed", "a save right after a restore makes a version of its own");

  // Version 2 had the skill, schedule and pages: one page is in the trash now.
  await archivePage(ids.owner, pricing.id);
  await age(router.id);
  const second = await restoreAgentVersion(ids.owner, router.id, 2);
  const afterSecond = await rowOf(router.id);
  const restoredSetup = await readSnapshot(afterSecond);
  check(
    second.skipped.length === 1 && second.skipped[0].part === "share" && second.skipped[0].reason === "trash" && second.skipped[0].name === "Pricing",
    "restoring version 2 skips the page now in the trash, and says so",
    second.skipped,
  );
  check(afterSecond.name === "Ticket router" && afterSecond.instructions === "Sort new tickets.\nBe very brief.\nAsk when unsure.", "…its settings come back");
  check(JSON.stringify(restoredSetup.skills) === JSON.stringify([triage.id]), "…its skill comes back");
  const schedules = await db.select().from(schedule).where(eq(schedule.agentId, router.id));
  check(
    schedules.length === 1 && schedules[0].id !== weekly.id && schedules[0].settings.task === "Go through open tickets" && schedules[0].databaseId === tickets.id && schedules[0].enabled && schedules[0].runAs === ids.owner,
    "…its schedule is made again, on, running as the owner who restored it",
    schedules,
  );
  check(restoredSetup.shares.length === 1 && restoredSetup.shares[0].pageId === handbook.id && restoredSetup.shares[0].level === "view", "…the page not in the trash is shared again", restoredSetup.shares);
  const left = await getAgentVersion(ids.owner, router.id, 2);
  check(
    !left.settings.length && !left.skills.added.length && !left.skills.removed.length && !left.schedules.added.length && !left.schedules.removed.length && !left.schedules.changed.length &&
      left.shares.removed.length === 1 && left.shares.removed[0].trashed && !left.shares.added.length,
    "…so version 2 differs from now only by the page in the trash (the schedule made again is the same one)",
    left,
  );

  // Order of skills, and a schedule changed in place.
  await addAgentSkill(ids.owner, router.id, tone.id);
  await age(router.id);
  const ordered = (await versionsOf(router.id)).at(-1)!.number;
  await removeAgentSkill(ids.owner, router.id, triage.id);
  await addAgentSkill(ids.owner, router.id, triage.id);
  await setAgentSchedule(ids.owner, router.id, schedules[0].id, { task: "Only urgent tickets" });
  await restoreAgentVersion(ids.owner, router.id, ordered);
  const reordered = await db.select({ pageId: agentSkill.pageId }).from(agentSkill).where(eq(agentSkill.agentId, router.id)).orderBy(asc(agentSkill.position));
  const [inPlace] = await db.select().from(schedule).where(eq(schedule.agentId, router.id));
  check(reordered.map((s) => s.pageId).join() === [triage.id, tone.id].join(), "restoring brings the skills' order back", reordered);
  check(inPlace.id === schedules[0].id && inPlace.settings.task === "Go through open tickets", "…and a changed schedule is set back in place", inPlace);

  // A snapshot with a setting gone since and one no longer valid: skipped, the rest restored.
  await age(router.id);
  const target = (await versionsOf(router.id)).find((v) => v.number === 1)!;
  await db
    .update(agentVersion)
    .set({ snapshot: { ...target.snapshot, settings: { ...target.snapshot.settings, retired_column: "x", monthly_token_limit: -5 } } })
    .where(eq(agentVersion.id, target.id));
  const odd = await restoreAgentVersion(ids.owner, router.id, 1);
  check(
    odd.skipped.some((s) => s.part === "setting" && s.name === "retired_column" && s.reason === "gone") &&
      odd.skipped.some((s) => s.part === "setting" && s.name === "monthly_token_limit" && s.reason === "invalid") &&
      (await rowOf(router.id)).instructions === "Sort new tickets.\nBe brief.",
    "a setting gone since or no longer valid is skipped; the rest comes back",
    odd.skipped,
  );

  // ── The baseline the migration makes ────────────────────────────────────────────────────────
  await addAgentSkill(ids.owner, router.id, tone.id);
  await agents.setAgentAccess(ids.owner, router.id, handbook.id, "edit");
  await setAgentSchedule(ids.owner, router.id, null, { rule: { ...daily, frequency: "weekly", weekdays: [1, 4] }, timeZone: ZONE, task: "Weekly digest" });
  const migration = readFileSync(new URL("../drizzle/0101_agent_versions.sql", import.meta.url), "utf8");
  const insert = migration.slice(migration.indexOf('INSERT INTO "agent_version"'));
  const select = insert
    .slice(insert.indexOf("SELECT"))
    .replace(/;\s*$/, "")
    .replace('FROM "workspace_agent" a', `FROM "workspace_agent" a WHERE a."id" = '${router.id}'`)
    .replace(/^SELECT gen_random_uuid\(\)::text, a\."id", 1, 'baseline', /, "SELECT ");
  const [baseline] = (await db.execute(sql.raw(select))) as unknown as Record<string, unknown>[];
  const baselineSnapshot = parseSnapshot(Object.values(baseline)[0]);
  const read = await readSnapshot(await rowOf(router.id));
  check(sameSnapshot(baselineSnapshot, read) && read.skills.length === 1 && read.schedules.length === 1 && read.shares.length === 1, "the migration's baseline reads a setup as the app does", { baselineSnapshot, read });

  // ── Shares from the page's Share menu count; an automation's don't ─────────────────────────
  await age(router.id);
  const agentUser = (await rowOf(router.id)).userId;
  await setPagePermission(ids.other, handbook.id, agentUser, "comment");
  versions = await versionsOf(router.id);
  check(versions.at(-1)!.createdBy === ids.other && JSON.stringify(versions.at(-1)!.changes) === '["shares"]', "sharing a page with the agent from the page's Share menu makes a version", versions.at(-1));
  const counted = versions.length;
  await agents.shareDatabaseWithAgents(ids.owner, tickets.id, [router.id]);
  const withAutomation = await readSnapshot(await rowOf(router.id));
  await agents.releaseDatabaseFromAgents(ids.owner, tickets.id, [router.id]);
  check(
    (await versionsOf(router.id)).length === counted && !withAutomation.shares.some((s) => s.pageId === tickets.id),
    "an automation sharing its database with the agent, and taking it back, makes none: it isn't part of its setup",
    withAutomation.shares,
  );

  // ── At most 50 ──────────────────────────────────────────────────────────────────────────────
  for (let i = 0; i < MAX_AGENT_VERSIONS + 5; i++) {
    await age(router.id);
    await agents.updateAgent(ids.owner, router.id, { description: `Draft ${i}` });
  }
  versions = await versionsOf(router.id);
  const top = versions.at(-1)!.number;
  check(versions.length === MAX_AGENT_VERSIONS && versions[0].number === top - MAX_AGENT_VERSIONS + 1, `an agent keeps its last ${MAX_AGENT_VERSIONS} versions`, versions.map((v) => v.number));
  check((await codeOf(restoreAgentVersion(ids.owner, router.id, 1))) === "versionNotFound", "…an older one can't be restored any more");

  await agents.archiveAgent(ids.owner, router.id);
  check((await codeOf(restoreAgentVersion(ids.owner, router.id, top))) === "archived", "an archived agent's versions can't be restored");

  console.log(`\n${passed} checks passed`);
} finally {
  const botUsers = (await db.select({ userId: workspaceAgent.userId }).from(workspaceAgent).where(eq(workspaceAgent.workspaceId, workspaceId))).map((a) => a.userId);
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, [...userIds, ...botUsers]));
  hocuspocus.closeConnections();
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}
