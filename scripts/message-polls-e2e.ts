/**
 * End-to-end check of polls in team messages against the database: a poll is sent as a message
 * whose text is its question; votes and taking them back, one choice or several; an anonymous
 * poll never tells anyone but the voter who chose what (views, live changes, sync); those outside
 * the channel can't vote; the author and the channel's admins close it, a plain member can't; a
 * closed or expired poll takes no votes; a poll's text can't be edited; deleting it drops its
 * votes. Live changes reach people through a fake connection each. Creates its own users and
 * workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/message-polls-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Needs no server.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { messagePoll, messagePollVote, user, workspace, workspaceMember } = await import("@/db/schema");
const channels = await import("@/server/messages/channels");
const posts = await import("@/server/messages/posts");
const polls = await import("@/server/messages/polls");
const { bootstrap, sync } = await import("@/server/messages/sync");
const { searchMessages } = await import("@/server/messages/search");
const { addConnection, removeConnection } = await import("@/server/messages/hub");
const { MessageError } = await import("@/server/messages/core");
await import("@/server/messages/announce");
type ServerFrame = import("@/lib/message-wire").ServerFrame;
type MessageView = import("@/lib/message-wire").MessageView;

const RUN = `message-polls-e2e-${Date.now().toString(36)}`;

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

async function refused(fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof MessageError && (!code || error.code === code);
  }
}

const ids = { owner: `${RUN}-owner`, ann: `${RUN}-ann`, bob: `${RUN}-bob`, cleo: `${RUN}-cleo`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;

/** A fake connection per person: the frames each was sent. */
const frames = new Map<string, ServerFrame[]>();
const connections = userIds.map((userId) => {
  const got: ServerFrame[] = [];
  frames.set(userId, got);
  return {
    id: `${RUN}-${userId}`,
    userId,
    sessionId: "s",
    workspaceId,
    guest: userId === ids.guest,
    knows: null,
    active: false,
    viewing: null as string | null,
    send: (frame: ServerFrame) => void got.push(frame),
    close: () => {},
  };
});
const clearFrames = () => {
  for (const list of frames.values()) list.length = 0;
};
/** Announcements run after the write's transaction; give them a moment. */
const settle = () => new Promise((r) => setTimeout(r, 150));
/** The last view of a message a person was sent live. */
const liveView = (userId: string, messageId: string): MessageView | undefined =>
  frames
    .get(userId)!
    .flatMap((f) => (f.t === "changes" ? (f.d.messages ?? []) : []))
    .filter((m) => m.id === messageId)
    .at(-1);
const viewOf = async (userId: string, messageId: string) => (await posts.messagesById(userId, [messageId]))[0];
const counts = (m: MessageView | undefined) => m?.poll?.options.map((o) => o.count);
const poll = (question: string, options: string[], more: { multiple?: boolean; anonymous?: boolean; closesAt?: string | null } = {}) => ({ question, options, ...more });

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id.split("-").at(-1)!, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.ann, role: "member" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId, userId: ids.cleo, role: "member" },
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  for (const id of [ids.owner, ids.ann, ids.bob, ids.cleo, ids.guest]) await bootstrap(id, workspaceId);

  // Ann's public channel with Bob in it (Cleo isn't); a private one with the guest; Ann is the admin of both.
  const team = await channels.createChannel(ids.ann, workspaceId, { name: "team", kind: "public", memberIds: [ids.bob] });
  const room = await channels.createChannel(ids.ann, workspaceId, { name: "room", kind: "private", memberIds: [ids.bob, ids.guest] });
  for (const c of connections) addConnection(c);

  // ------------------------------------------------------------------ sending
  check(await refused(() => polls.sendPoll(ids.ann, { channelId: team, poll: poll("Lunch?", ["Pizza", ""]) }), "invalid"), "a poll needs two options");
  check(await refused(() => polls.sendPoll(ids.ann, { channelId: team, poll: poll("Lunch?", ["Pizza", "pizza"]) }), "invalid"), "options may not repeat");
  check(await refused(() => polls.sendPoll(ids.ann, { channelId: team, poll: poll("Lunch?", ["a", "b"], { closesAt: new Date(Date.now() - 60_000).toISOString() }) }), "invalid"), "a poll can't close in the past");
  check(await refused(() => polls.sendPoll(ids.cleo, { channelId: team, poll: poll("Mine?", ["a", "b"]) }), "notMember"), "only the channel's people send polls there");
  clearFrames();
  const lunchId = crypto.randomUUID();
  const sent = await polls.sendPoll(ids.ann, { id: lunchId, channelId: team, poll: poll(" Lunch  today? ", ["Pizza", "Soup", " ", "Salad"]) });
  check(sent.message.body === "Lunch today?" && sent.message.poll?.question === "Lunch today?", "the poll's question is the message's text", sent.message);
  check(sent.message.poll?.options.length === 3 && !sent.message.poll.multiple && !sent.message.poll.anonymous, "empty options are dropped; one answer, named, by default");
  const again = await polls.sendPoll(ids.ann, { id: lunchId, channelId: team, poll: poll("Lunch today?", ["Pizza", "Soup", "Salad"]) });
  check(again.message.id === lunchId && (await db.select().from(messagePoll).where(eq(messagePoll.messageId, lunchId))).length === 1, "sending the same poll again stores it once");
  await settle();
  check(liveView(ids.bob, lunchId)?.poll?.question === "Lunch today?", "the channel's people get the poll live");
  check(!liveView(ids.cleo, lunchId), "someone outside a public channel who hasn't it open doesn't");
  const found = await searchMessages(ids.bob, workspaceId, { query: "lunch" });
  check(found.messages.some((m) => m.id === lunchId && m.poll), "search finds a poll by its question", found);
  check(await refused(() => posts.editMessage(ids.ann, lunchId, { body: "Dinner?" }), "notAllowed"), "a poll's question can't be edited");

  // ------------------------------------------------------------------ votes, one answer
  const [pizza, soup, salad] = sent.message.poll!.options.map((o) => o.id);
  clearFrames();
  await polls.votePoll(ids.bob, lunchId, pizza, true);
  await settle();
  let bobs = await viewOf(ids.bob, lunchId);
  check(bobs.poll?.mine.join() === pizza && counts(bobs)?.join() === "1,0,0" && bobs.poll.voters === 1, "a vote counts and is the voter's own", bobs.poll);
  check(bobs.poll.options[0].voters?.join() === ids.bob, "a named poll says who voted");
  check(liveView(ids.ann, lunchId)?.poll?.options[0].count === 1 && liveView(ids.ann, lunchId)?.poll?.mine.length === 0, "others get the new counts live, without the voter's choice as theirs");
  check(liveView(ids.bob, lunchId)?.poll?.mine.join() === pizza, "the voter gets their own choice live");
  await polls.votePoll(ids.bob, lunchId, soup, true);
  bobs = await viewOf(ids.bob, lunchId);
  check(bobs.poll?.mine.join() === soup && counts(bobs)?.join() === "0,1,0", "with one answer, a new choice replaces the old", bobs.poll);
  await polls.votePoll(ids.ann, lunchId, soup, true);
  await polls.votePoll(ids.bob, lunchId, soup, false);
  bobs = await viewOf(ids.bob, lunchId);
  check(bobs.poll?.mine.length === 0 && counts(bobs)?.join() === "0,1,0" && bobs.poll.voters === 1, "taking a vote back", bobs.poll);
  check(await refused(() => polls.votePoll(ids.bob, lunchId, "nope", true), "invalid"), "an option the poll hasn't is refused");
  check(await refused(() => polls.votePoll(ids.cleo, lunchId, pizza, true), "notMember"), "someone who may read a public channel but isn't in it can't vote");
  check(await refused(() => polls.votePoll(ids.outsider, lunchId, pizza, true), "notFound"), "someone outside the workspace can't vote");
  check(counts(await viewOf(ids.cleo, lunchId))?.join() === "0,1,0", "but they see the results");
  void salad;

  // ------------------------------------------------------------------ several answers, guests
  const many = (await polls.sendPoll(ids.ann, { channelId: room, poll: poll("Which days?", ["Mon", "Tue", "Wed"], { multiple: true }) })).message;
  const [mon, tue, wed] = many.poll!.options.map((o) => o.id);
  await polls.votePoll(ids.guest, many.id, mon, true);
  await polls.votePoll(ids.guest, many.id, wed, true);
  await polls.votePoll(ids.bob, many.id, wed, true);
  let guests = await viewOf(ids.guest, many.id);
  check(guests.poll?.mine.join() === `${mon},${wed}` && counts(guests)?.join() === "1,0,2" && guests.poll.voters === 2, "several answers add up; a guest in the channel votes", guests.poll);
  await polls.votePoll(ids.guest, many.id, mon, false);
  guests = await viewOf(ids.guest, many.id);
  check(guests.poll?.mine.join() === wed && guests.poll.voters === 2, "taking one of several back keeps the others");
  check(await refused(() => polls.votePoll(ids.cleo, many.id, tue, true), "notFound"), "someone outside a private channel can't vote, nor see it");

  // ------------------------------------------------------------------ anonymous
  const secret = (await polls.sendPoll(ids.ann, { channelId: team, poll: poll("Rate the offsite", ["Good", "Bad"], { anonymous: true }) })).message;
  const [good] = secret.poll!.options.map((o) => o.id);
  const before = (await bootstrap(ids.ann, workspaceId)).rev;
  clearFrames();
  await polls.votePoll(ids.bob, secret.id, good, true);
  await settle();
  const annSees = await viewOf(ids.ann, secret.id);
  check(annSees.poll?.anonymous && annSees.poll.options.every((o) => o.voters === null) && annSees.poll.options[0].count === 1, "an anonymous poll shows its author counts only", annSees.poll);
  check(annSees.poll.mine.length === 0, "and none of the voter's choices as theirs");
  const annFrames = JSON.stringify(frames.get(ids.ann));
  check(liveView(ids.ann, secret.id)?.poll?.options[0].count === 1 && !annFrames.includes(ids.bob), "the live change others get names no voter anywhere", frames.get(ids.ann));
  check(liveView(ids.bob, secret.id)?.poll?.mine.join() === good, "while the voter is told their own choice");
  const caught = await sync(ids.ann, workspaceId, before);
  const synced = !caught.reset ? caught.messages?.find((m) => m.id === secret.id) : undefined;
  check(synced?.poll?.options[0].count === 1 && !JSON.stringify(synced).includes(ids.bob), "sync brings others the new count without the voter", synced);
  const bobSees = await viewOf(ids.bob, secret.id);
  check(bobSees.poll?.mine.join() === good && bobSees.poll.options[0].voters === null, "the voter sees their choice, still not a list of voters");
  const history = await posts.channelHistory(ids.ann, { channelId: team });
  check(!JSON.stringify(history.messages.find((m) => m.id === secret.id)).includes(ids.bob), "nor does the channel's history name them");

  // ------------------------------------------------------------------ closing
  check(await refused(() => polls.closePoll(ids.bob, lunchId), "notAllowed"), "a plain member can't close someone else's poll");
  const bobsPoll = (await polls.sendPoll(ids.bob, { channelId: team, poll: poll("Bob's?", ["Yes", "No"]) })).message;
  await polls.closePoll(ids.bob, bobsPoll.id);
  check((await viewOf(ids.ann, bobsPoll.id)).poll?.closedAt, "the author closes their poll");
  check(await refused(() => polls.votePoll(ids.ann, bobsPoll.id, bobsPoll.poll!.options[0].id, true), "pollClosed"), "a closed poll takes no votes");
  await polls.closePoll(ids.ann, lunchId);
  const closed = await viewOf(ids.bob, lunchId);
  check(closed.poll?.closedAt && closed.poll.closedBy === ids.ann && counts(closed)?.join() === "0,1,0", "the author closes theirs and the votes stay");
  check(await refused(() => polls.votePoll(ids.ann, lunchId, soup, false), "pollClosed"), "nor takes them back");
  const ownerPoll = (await polls.sendPoll(ids.bob, { channelId: team, poll: poll("Owner closes?", ["Yes", "No"]) })).message;
  await polls.closePoll(ids.owner, ownerPoll.id);
  check((await viewOf(ids.bob, ownerPoll.id)).poll?.closedBy === ids.owner, "the workspace's owner may close anyone's poll, as they may delete it");

  // ------------------------------------------------------------------ expiry
  const soon = (await polls.sendPoll(ids.ann, { channelId: team, poll: poll("Quick one?", ["Yes", "No"], { closesAt: new Date(Date.now() + 3600_000).toISOString() }) })).message;
  check(soon.poll?.closesAt && !soon.poll.closedAt, "a poll may close at a set time");
  await polls.votePoll(ids.bob, soon.id, soon.poll!.options[0].id, true);
  await db.execute(sql`update message_poll set closes_at = now() - interval '1 minute' where message_id = ${soon.id}`);
  check(await refused(() => polls.votePoll(ids.ann, soon.id, soon.poll!.options[1].id, true), "pollClosed"), "past its time it takes no votes");

  // ------------------------------------------------------------------ deleting
  check((await db.select().from(messagePollVote).where(eq(messagePollVote.messageId, many.id))).length === 2, "the poll has its votes");
  await posts.deleteMessage(ids.ann, many.id);
  check((await db.select().from(messagePollVote).where(eq(messagePollVote.messageId, many.id))).length === 0, "deleting the message drops its votes");
  check((await db.select().from(messagePoll).where(eq(messagePoll.messageId, many.id))).length === 0, "and its poll");
  const gone = await viewOf(ids.bob, many.id);
  check(gone.deletedAt && gone.poll === null && gone.body === "", "a deleted poll shows as any deleted message");
  check(await refused(() => polls.votePoll(ids.bob, many.id, wed, true), "notFound"), "and takes no votes");

  for (const c of connections) removeConnection(c);
  console.log(`\n${passed} checks passed`);
} finally {
  for (const c of connections) removeConnection(c);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  process.exit(process.exitCode ?? 0);
}
