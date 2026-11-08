/**
 * End-to-end check of importing a Slack export into Messages against the database: the fixture
 * (lib/import/slack-fixtures.ts) zipped, unpacked and read; only owners import; channels come in
 * with free names (a taken one gets a number), their kinds, topics and archived state; people
 * matched by email write as themselves, the others show their Slack name; seq follows the
 * original times, which messages keep; threads count their replies; reactions of matched people
 * only; everyone starts with the history read and nobody is mentioned or notified; connected
 * clients hear of the channels, not of every message; importing again leaves the channels be;
 * files are downloaded through the guarded fetch (from a local server allowed for the test) or
 * linked to their page on Slack. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/slack-import-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

try {
  process.loadEnvFile();
} catch {}

// A local server stands in for Slack's file host: allowed as an address anyone may give, for this run only.
const fileServer = createServer((request, response) => {
  if (request.url?.startsWith("/spec.pdf")) {
    response.writeHead(200, { "content-type": "application/pdf" });
    response.end("%PDF-1.4 test");
  } else {
    response.writeHead(302, { location: "/signin" });
    response.end();
  }
});
await new Promise<void>((resolve) => fileServer.listen(0, "127.0.0.1", resolve));
const filePort = (fileServer.address() as AddressInfo).port;
process.env.WEB_FETCH_ALLOWED_HOSTS = `127.0.0.1:${filePort}`;

const { and, asc, eq, inArray } = await import("drizzle-orm");
const { zipSync } = await import("fflate");
const { db } = await import("@/db");
const { channel, channelMember, channelMessage, messageFile, messageMention, messageReaction, messageThread, user, workspace, workspaceMember } = await import("@/db/schema");
const { readSlackExport } = await import("@/lib/import/slack");
const { slackFixtureFiles } = await import("@/lib/import/slack-fixtures");
const { importSlackExport, unpackSlackExport, SLACK_LIMITS } = await import("@/server/messages/import");
const channels = await import("@/server/messages/channels");
const posts = await import("@/server/messages/posts");
const { bootstrap } = await import("@/server/messages/sync");
const { addConnection, removeConnection } = await import("@/server/messages/hub");
await import("@/server/messages/announce");
type ServerFrame = import("@/lib/message-wire").ServerFrame;

const RUN = `slack-e2e-${Date.now().toString(36)}`;
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

const ids = { owner: `${RUN}-owner`, ayse: `${RUN}-ayse`, bora: `${RUN}-bora`, member: `${RUN}-member` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const emails = { ayse: `${RUN}-ayse@example.test`, bora: `${RUN}-bora@example.test` };

const frames: ServerFrame[] = [];
const connection = { id: `${RUN}-c`, userId: ids.member, sessionId: "s", workspaceId, guest: false, active: true, viewing: null, send: (f: ServerFrame) => void frames.push(f), close: () => {} };

/** The fixture as Slack zips it, with its file pointing at the local server. */
function fixtureZip(): Uint8Array {
  const files = slackFixtureFiles(emails);
  const entries: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) {
    const text = new TextDecoder().decode(bytes).replace("https://files.slack.com/files-pri/T1-F1/download/spec.pdf?t=xoxe-secret", `http://127.0.0.1:${filePort}/spec.pdf`);
    entries[path] = new TextEncoder().encode(text);
  }
  return zipSync(entries);
}

try {
  await db.insert(user).values([
    { id: ids.owner, name: "Owner", email: `${RUN}-owner@example.test` },
    { id: ids.ayse, name: "Ayşe K.", email: emails.ayse },
    { id: ids.bora, name: "Bora D.", email: emails.bora },
    { id: ids.member, name: "Member", email: `${RUN}-member@example.test` },
  ]);
  await db.insert(workspace).values({ id: workspaceId, name: RUN });
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.ayse, role: "member" },
    { workspaceId, userId: ids.bora, role: "member" },
    { workspaceId, userId: ids.member, role: "member" },
  ]);
  // The workspace's first visit makes its general channel: the import's #general must take another name.
  await bootstrap(ids.owner, workspaceId);
  await channels.createChannel(ids.owner, workspaceId, { name: "general", kind: "public" }).catch(() => undefined);
  await bootstrap(ids.member, workspaceId);
  addConnection(connection);

  const read = readSlackExport(unpackSlackExport(fixtureZip()));
  check(read.channels.length === 3, "the zipped export is unpacked and read", read.channels.map((c) => c.name));

  let refused = false;
  try {
    await importSlackExport(ids.member, workspaceId, read);
  } catch (error) {
    refused = (error as Error).name === "AccessError";
  }
  check(refused, "only owners import");

  SLACK_LIMITS.chunk = 3; // several writes per channel, as a large one has
  const result = await importSlackExport(ids.owner, workspaceId, read, { download: true });
  await new Promise((r) => setTimeout(r, 200));
  check(result.created.channels === 3, "three channels came in", result);
  const general = result.channels.find((c) => c.name.startsWith("general"))!;
  check(general.name !== "general" && result.warnings.some((w) => w.code === "renamed" && w.from === "general" && w.to === general.name), "a taken name gets a number and is reported", result.warnings);
  check(result.people.matched === 2 && result.warnings.some((w) => w.code === "unmatchedPeople" && w.names.includes("Cem")), "people match by email (any case); the others are reported", result.people);
  check(result.warnings.some((w) => w.code === "directLeftOut" && w.count === 1), "direct conversations are left out, and said so");
  check(result.warnings.some((w) => w.code === "repliesWithoutThread" && w.count === 1), "orphan replies are reported");
  check(result.warnings.some((w) => w.code === "reactionsLeftOut" && w.count === 2), "a custom emoji and an unmatched person's reaction are left out", result.warnings);

  const [row] = await db.select().from(channel).where(eq(channel.id, general.id));
  check(row.kind === "public" && row.topic === "Company-wide" && row.description === "Everything & anything", "topic and purpose come along", row);
  check(row.createdAt.getTime() === 1_699_999_000_000 && row.createdBy === ids.ayse, "the channel keeps its creation time and maker");
  const [old] = await db
    .select()
    .from(channel)
    .where(and(eq(channel.name, "old-project"), eq(channel.workspaceId, workspaceId)));
  check(old?.archivedAt, "an archived channel comes in archived");
  const secret = result.channels.find((c) => c.name === "secret-plans")!;
  check(secret.kind === "private", "a private channel stays private");
  const secretMembers = await db.select().from(channelMember).where(eq(channelMember.channelId, secret.id));
  check(
    secretMembers.map((m) => m.userId).sort().join() === [ids.owner, ids.bora].sort().join(),
    "a private channel holds its matched members and the importing owner",
    secretMembers,
  );

  const rows = await db.select().from(channelMessage).where(eq(channelMessage.channelId, general.id)).orderBy(asc(channelMessage.seq));
  check(rows.length === read.channels[0].messages.length && row.lastSeq === rows.length, "every message came in, and lastSeq counts them", { rows: rows.length, lastSeq: row.lastSeq });
  check(
    rows.every((r, i) => r.seq === i + 1 && (i === 0 || r.createdAt >= rows[i - 1].createdAt)),
    "seq runs 1..n in the order of the original times",
  );
  check(rows[0].createdAt.getTime() === 1_700_000_000_000, "messages keep their original time");
  const byText = (text: string) => rows.find((r) => r.body.includes(text))!;
  const first = rows[0];
  check(first.authorId === ids.ayse && first.data === null, "a matched person writes as themselves");
  check(first.body === "Hello **team** & welcome to #old-project! 👋 👍🏼", "text becomes Markdown, channels their names, emoji names emoji", first.body);
  const thread = byText("Plan for");
  check(thread.body.includes(`(leafdesk:user/${ids.ayse})`) && thread.editedAt, "people named become mentions; an edit keeps its time", thread);
  check(thread.replyCount === 3 && thread.lastReplySeq === rows.find((r) => r.body.startsWith("Shipping"))!.seq, "a thread counts its replies", thread);
  check(thread.repliers[0] === ids.bora && thread.repliers.includes(ids.ayse), "its repliers are the matched ones, newest first", thread.repliers);
  const reply = byText("Looks good");
  check(reply.threadId === thread.id && reply.authorId === null && reply.data?.importedFrom?.name === "Cem", "an unmatched person's reply shows their name, in its thread", reply);
  const broadcast = byText("Shipping it");
  check(broadcast.alsoInChannel && broadcast.body === "Shipping it @channel", "a reply sent to the channel too stays so; @channel stays a word");
  const bot = byText("Deployed v1.2");
  check(bot.data?.importedFrom?.name === "Deploy Bot" && bot.seq === broadcast.seq + 1, "a bot's message shows its name, after a message of the same millisecond", bot);
  const tomb = rows.find((r) => r.deletedAt)!;
  check(tomb && tomb.body === "" && tomb.replyCount === 1, "a deleted thread start stays, empty, over its reply");
  check(!byText("Reply to a message the export lacks").threadId, "a reply whose thread is missing is a message of its own");
  const shared = byText("The spec");
  const files = await db.select().from(messageFile).where(eq(messageFile.messageId, shared.id));
  check(files.length === 1 && result.created.files === 1 && !shared.body.includes("spec.pdf"), "a file is downloaded through the guarded fetch and attached", { files, body: shared.body });
  check(!shared.body.includes("xoxe"), "no download address (with its token) is written into a message");

  const reactions = await db.select().from(messageReaction).where(inArray(messageReaction.messageId, rows.map((r) => r.id)));
  check(
    reactions.length === 2 && reactions.some((r) => r.userId === ids.bora && r.emoji === "❤️") && reactions.some((r) => r.userId === ids.bora && r.emoji === "👍️"),
    "reactions of matched people come in as the picker's emoji",
    reactions,
  );
  const mentions = await db.select().from(messageMention).where(inArray(messageMention.messageId, rows.map((r) => r.id)));
  const follows = await db.select().from(messageThread).where(eq(messageThread.channelId, general.id));
  check(!mentions.length && !follows.length, "no one is mentioned or made to follow old threads");
  const members = await db.select().from(channelMember).where(eq(channelMember.channelId, general.id));
  check(members.length === 3 && members.every((m) => m.lastReadSeq === row.lastSeq && m.mentions === 0), "everyone starts with the history read", members);
  check(members.find((m) => m.userId === ids.owner)?.role === "admin" && members.find((m) => m.userId === ids.ayse)?.role === "admin", "the maker and the importing owner are its admins");

  const view = await bootstrap(ids.ayse, workspaceId);
  const listed = view.memberships?.find((m) => m.channelId === general.id);
  check(listed && view.channels?.find((c) => c.id === general.id)?.lastSeq === rows.length, "it is in its people's list");
  const history = await posts.channelHistory(ids.ayse, { channelId: general.id });
  check(history.messages.at(-1)?.body.includes("The spec") && history.messages.every((m) => !m.threadId || m.alsoInChannel), "its history reads in order, replies in their threads");
  const replies = await posts.threadMessages(ids.ayse, thread.id);
  check(replies.replies.length === 3, "the thread reads its replies");

  const changes = frames.filter((f): f is Extract<ServerFrame, { t: "changes" }> => f.t === "changes").map((f) => f.d);
  check(changes.some((c) => c.channels?.some((ch) => ch.id === general.id)), "a connected member hears of the new channel");
  check(!changes.some((c) => c.messages?.length), "but isn't sent every imported message");
  check(!changes.some((c) => c.channels?.some((ch) => ch.id === secret.id)), "nor of a private channel they aren't in");

  const again = await importSlackExport(ids.owner, workspaceId, read);
  check(again.created.channels === 0 && again.warnings.filter((w) => w.code === "alreadyImported").length === 3, "importing again leaves the channels be", again);
  const count = await db.$count(channelMessage, eq(channelMessage.channelId, general.id));
  check(count === rows.length, "and adds no message");

  // Without downloading, a file links to its page on Slack.
  await db.delete(channel).where(and(eq(channel.workspaceId, workspaceId), inArray(channel.id, result.channels.map((c) => c.id))));
  const linked = await importSlackExport(ids.owner, workspaceId, read);
  const linkedGeneral = linked.channels.find((c) => c.name.startsWith("general"))!;
  const [spec] = await db.select().from(channelMessage).where(and(eq(channelMessage.channelId, linkedGeneral.id), eq(channelMessage.seq, rows.find((r) => r.id === shared.id)!.seq)));
  check(spec.body === "The spec\n[spec.pdf](https://team.slack.com/files/U2/F1/spec.pdf)" && linked.warnings.some((w) => w.code === "filesAsLinks" && w.count === 1), "without downloads a file links to its page", spec.body);

  console.log(`\n${passed} checks passed`);
} finally {
  removeConnection(connection);
  fileServer.close();
  await db.delete(workspace).where(eq(workspace.id, workspaceId));
  await db.delete(user).where(inArray(user.id, userIds));
  process.exit(process.exitCode ?? 0);
}
