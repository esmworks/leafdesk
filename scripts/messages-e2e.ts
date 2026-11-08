/**
 * End-to-end check of team messages against the database: the first visit makes the general
 * channel with everyone in it; public, private and direct channels and who may see, read and
 * write each (guests, people outside, admins-only posting); sending is idempotent by the client's
 * id; unread counts and mentions (by name, @channel, @here only for those present) and marking
 * read and unread; threads (reply counts, followers, "also in channel"); edits keep their history;
 * deletes empty the message; reactions, pins, saved messages and their reminders; drafts; search
 * with filters; scheduled messages; `sync` after a lost connection brings what changed, deletions
 * included; live changes reach only the connected people who may see them (a fake connection per
 * person). Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/messages-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: its sweep would send the scheduled messages.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { eq, inArray } = await import("drizzle-orm");
const { db } = await import("@/db");
const { channelMessage, user, workspace, workspaceMember } = await import("@/db/schema");
const { refLink } = await import("@/lib/message-text");
const channels = await import("@/server/messages/channels");
const posts = await import("@/server/messages/posts");
const { bootstrap, sync } = await import("@/server/messages/sync");
const { searchMessages } = await import("@/server/messages/search");
const { runMessageTimers, scheduleMessage } = await import("@/server/messages/scheduled");
const { addConnection, removeConnection, setActive, setViewing } = await import("@/server/messages/hub");
const { MessageError } = await import("@/server/messages/core");
await import("@/server/messages/announce");
type ServerFrame = import("@/lib/message-wire").ServerFrame;
type Changes = import("@/lib/message-wire").Changes;

const RUN = `messages-e2e-${Date.now().toString(36)}`;

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

const ids = { owner: `${RUN}-owner`, ann: `${RUN}-ann`, bob: `${RUN}-bob`, guest: `${RUN}-guest`, outsider: `${RUN}-outsider` };
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
    active: false,
    viewing: null as string | null,
    send: (frame: ServerFrame) => void got.push(frame),
    close: () => {},
  };
});
const changesFor = (userId: string): Changes[] => frames
  .get(userId)!
  .filter((f): f is Extract<ServerFrame, { t: "changes" }> => f.t === "changes")
  .map((f) => f.d);
const clearFrames = () => {
  for (const list of frames.values()) list.length = 0;
};
/** Announcements run after the write's transaction; give them a moment. */
const settle = () => new Promise((r) => setTimeout(r, 150));
const sawMessage = (userId: string, messageId: string) => changesFor(userId).some((c) => c.messages?.some((m) => m.id === messageId));
const membership = async (userId: string, channelId: string) => (await bootstrap(userId, workspaceId)).memberships?.find((m) => m.channelId === channelId);
const mention = (userId: string, name: string) => refLink({ kind: "user", id: userId }, `@${name}`);

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
    { workspaceId, userId: ids.guest, role: "guest" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);

  // ------------------------------------------------------------------ the first visit
  const first = await bootstrap(ids.owner, workspaceId);
  const general = first.channels!.find((c) => c.kind === "public");
  check(general && general.joinNew && general.name, "the first visit makes a general channel", first.channels);
  check(first.memberships!.some((m) => m.channelId === general.id), "the owner is in it");
  await bootstrap(ids.ann, workspaceId);
  await bootstrap(ids.bob, workspaceId);
  check(await membership(ids.bob, general.id), "members join the general channel on their first visit");
  const guestStart = await bootstrap(ids.guest, workspaceId);
  check(!guestStart.memberships!.some((m) => m.channelId === general.id), "a guest isn't put in it");
  check(!guestStart.channels!.some((c) => c.id === general.id), "and doesn't see public channels");
  check(await refused(() => bootstrap(ids.outsider, workspaceId), "notFound"), "someone outside the workspace is refused");

  for (const c of connections) addConnection(c);

  // ------------------------------------------------------------------ channels
  const design = await channels.createChannel(ids.ann, workspaceId, { name: "Design Team", kind: "public", topic: "pixels" });
  const secret = await channels.createChannel(ids.ann, workspaceId, { name: "secret", kind: "private", memberIds: [ids.bob] });
  check(await refused(() => channels.createChannel(ids.bob, workspaceId, { name: "design-team", kind: "public" }), "nameTaken"), "channel names are unique (folded)");
  check(await refused(() => channels.createChannel(ids.guest, workspaceId, { name: "guests", kind: "public" })), "guests can't make channels");
  await settle();
  check(changesFor(ids.owner).some((c) => c.channels?.some((ch) => ch.id === design)), "a new public channel is announced to members");
  check(!changesFor(ids.owner).some((c) => c.channels?.some((ch) => ch.id === secret)), "a private one isn't, to those outside it");
  check(!changesFor(ids.guest).some((c) => c.channels?.some((ch) => ch.id === design)), "nor public ones to guests");
  check(await refused(() => posts.channelHistory(ids.owner, { channelId: secret }), "notFound"), "a private channel can't be read from outside, even by an owner");
  check((await posts.channelHistory(ids.bob, { channelId: secret })).messages.length >= 1, "its members read it");
  await channels.joinChannel(ids.bob, design);
  check(await refused(() => channels.joinChannel(ids.owner, secret)), "a private channel can't be joined");

  // ------------------------------------------------------------------ sending, unread, mentions
  clearFrames();
  const m1 = crypto.randomUUID();
  const sent = await posts.sendMessage(ids.ann, { id: m1, channelId: design, body: `Hello ${mention(ids.bob, "bob")} and ${mention(ids.owner, "owner")}` });
  check(sent.message.id === m1 && sent.message.seq > 0, "a message keeps the client's id");
  check(sent.notInChannel.includes(ids.owner) && !sent.notInChannel.includes(ids.bob), "people named outside the channel are listed for the writer", sent.notInChannel);
  const again = await posts.sendMessage(ids.ann, { id: m1, channelId: design, body: "something else" });
  check(again.message.id === m1 && again.message.body === sent.message.body, "sending the same id again returns the first message");
  await settle();
  check(sawMessage(ids.bob, m1), "members are sent the new message");
  check(!sawMessage(ids.owner, m1), "people outside a public channel aren't, unless they look at it");
  check(!sawMessage(ids.guest, m1), "guests aren't");
  const bobIn = await membership(ids.bob, design);
  check(bobIn?.unread === 1 && bobIn.mentions === 1, "it counts as unread and as a mention", bobIn);
  const annIn = await membership(ids.ann, design);
  check(annIn?.unread === 0, "the writer's own message isn't unread");
  await posts.markRead(ids.bob, design, sent.message.seq);
  const bobRead = await membership(ids.bob, design);
  check(bobRead?.unread === 0 && bobRead.mentions === 0, "reading clears unread and mentions", bobRead);
  await posts.markUnread(ids.bob, design, sent.message.seq);
  check((await membership(ids.bob, design))?.unread === 1, "marking unread from a message brings it back");
  await posts.markAllRead(ids.bob, workspaceId);
  check((await membership(ids.bob, design))?.unread === 0, "mark all read");

  // Viewing a public channel one isn't in brings its messages live.
  clearFrames();
  setActive(connections[0], true);
  setViewing(connections[0], design);
  const m2 = (await posts.sendMessage(ids.ann, { channelId: design, body: "@here and everyone", id: crypto.randomUUID() })).message;
  await settle();
  check(sawMessage(ids.owner, m2.id), "someone viewing a public channel is sent its messages");
  check(frames.get(ids.owner)!.some((f) => f.t === "viewers"), "and the channel's viewers are told");
  setViewing(connections[0], null);

  const here = (await posts.sendMessage(ids.ann, { channelId: design, body: refLink({ kind: "here" }, "@here"), id: crypto.randomUUID() })).message;
  check((await membership(ids.bob, design))?.mentions === 0, "@here leaves out those not present", here.id);
  setActive(connections[2], true);
  await posts.sendMessage(ids.ann, { channelId: design, body: refLink({ kind: "here" }, "@here"), id: crypto.randomUUID() });
  check((await membership(ids.bob, design))?.mentions === 1, "@here reaches those present");
  await posts.sendMessage(ids.ann, { channelId: design, body: refLink({ kind: "everyone" }, "@channel"), id: crypto.randomUUID() });
  check((await membership(ids.bob, design))?.mentions === 2, "@channel reaches everyone in it");
  await posts.markAllRead(ids.bob, workspaceId);

  check(await refused(() => posts.sendMessage(ids.owner, { channelId: design, body: "hi", id: crypto.randomUUID() }), "notMember"), "people outside a channel can't write in it");
  await channels.updateChannel(ids.ann, design, { posting: "admins" });
  check(await refused(() => posts.sendMessage(ids.bob, { channelId: design, body: "hi", id: crypto.randomUUID() }), "adminsOnly"), "admins-only posting refuses members");
  await channels.updateChannel(ids.ann, design, { posting: "everyone" });

  // ------------------------------------------------------------------ threads
  const root = sent.message;
  const r1 = (await posts.sendMessage(ids.bob, { channelId: design, threadId: root.id, body: "a reply", id: crypto.randomUUID() })).message;
  const r2 = (await posts.sendMessage(ids.ann, { channelId: design, threadId: root.id, body: "also shown", alsoInChannel: true, id: crypto.randomUUID() })).message;
  const thread = await posts.threadMessages(ids.ann, root.id);
  check(thread.root.replyCount === 2 && thread.replies.map((r) => r.id).join() === [r1.id, r2.id].join(), "a thread lists its replies and counts them", thread.root);
  const bobThreads = (await bootstrap(ids.bob, workspaceId)).threads!;
  check(bobThreads.some((t) => t.threadId === root.id && t.following), "replying follows the thread");
  const history = await posts.channelHistory(ids.bob, { channelId: design });
  check(!history.messages.some((m) => m.id === r1.id) && history.messages.some((m) => m.id === r2.id), "replies stay in their thread unless also sent to the channel");
  await posts.followThread(ids.bob, root.id, false);
  check(!(await bootstrap(ids.bob, workspaceId)).threads!.some((t) => t.threadId === root.id && t.following), "unfollowing a thread");

  // ------------------------------------------------------------------ edits, deletes, reactions, pins
  await posts.editMessage(ids.ann, root.id, { body: "Hello everyone" });
  const versions = await posts.messageHistory(ids.bob, root.id);
  check(versions.length === 1 && versions[0].body.startsWith("Hello"), "an edit keeps the earlier text", versions);
  check(await refused(() => posts.editMessage(ids.bob, root.id, { body: "hijack" }), "notAllowed"), "only the writer edits a message");
  await posts.react(ids.bob, root.id, "👍", true);
  await posts.react(ids.ann, root.id, "👍", true);
  const [reacted] = await posts.messagesById(ids.bob, [root.id]);
  check(reacted.reactions.find((r) => r.emoji === "👍")?.userIds.length === 2, "reactions gather by emoji");
  check(await refused(() => posts.react(ids.bob, root.id, "not an emoji", true), "invalid"), "a reaction must be an emoji");
  await posts.pin(ids.bob, root.id, true);
  check((await posts.pinnedMessages(ids.ann, design)).some((m) => m.id === root.id), "a pinned message is listed");
  const doomed = (await posts.sendMessage(ids.ann, { channelId: design, body: "oops", id: crypto.randomUUID() })).message;
  check(await refused(() => posts.deleteMessage(ids.bob, doomed.id)), "a member can't delete someone else's message");
  const byAdmin = (await posts.sendMessage(ids.bob, { channelId: design, body: "moderated", id: crypto.randomUUID() })).message;
  await posts.deleteMessage(ids.ann, byAdmin.id);
  check((await posts.messagesById(ids.ann, [byAdmin.id]))[0].deletedAt, "a channel's admin may delete others' messages");
  await posts.deleteMessage(ids.ann, doomed.id);
  const [gone] = await posts.messagesById(ids.bob, [doomed.id]);
  check(gone.deletedAt && gone.body === "", "a deleted message keeps its place, emptied", gone);

  // ------------------------------------------------------------------ direct conversations
  const dm = await channels.openDirect(ids.ann, workspaceId, [ids.bob]);
  check((await channels.openDirect(ids.bob, workspaceId, [ids.ann])) === dm, "a direct conversation between the same people is one");
  check(await refused(() => posts.channelHistory(ids.owner, { channelId: dm }), "notFound"), "nobody else reads it");
  check(await refused(() => channels.openDirect(ids.guest, workspaceId, [ids.owner])), "a guest writes only to people they share a channel with");
  check(await refused(() => channels.openDirect(ids.ann, workspaceId, [ids.outsider])), "only people of the workspace");

  // Unread counts are each channel's own, and member counts each channel's (both are subqueries
  // in the channel and membership views).
  await posts.markAllRead(ids.bob, workspaceId);
  for (const body of ["one", "two"]) await posts.sendMessage(ids.ann, { channelId: dm, body, id: crypto.randomUUID() });
  await posts.sendMessage(ids.ann, { channelId: design, body: "three", id: crypto.randomUUID() });
  const counts = await bootstrap(ids.bob, workspaceId);
  const unreadIn = (id: string) => counts.memberships!.find((m) => m.channelId === id)?.unread;
  check(unreadIn(dm) === 2 && unreadIn(design) === 1 && unreadIn(general.id) === 0, "unread counts are per channel", counts.memberships);
  const peopleIn = (id: string) => counts.channels!.find((c) => c.id === id)?.memberCount;
  check(peopleIn(dm) === 2 && peopleIn(secret) === 2 && peopleIn(general.id) === 3, "member counts are per channel", counts.channels);
  await posts.markAllRead(ids.bob, workspaceId);

  // Any member may set the topic, as the socket's call sends it (with the channel's id beside it);
  // other changes stay with the channel's admins.
  await channels.updateChannel(ids.bob, design, { channelId: design, topic: "new pixels" } as never);
  check((await bootstrap(ids.bob, workspaceId)).channels!.find((c) => c.id === design)?.topic === "new pixels", "a member sets the topic");
  check(await refused(() => channels.updateChannel(ids.bob, design, { channelId: design, name: "renamed" } as never)), "but doesn't rename the channel");

  // ------------------------------------------------------------------ saved, drafts, search
  await posts.saveForLater(ids.bob, root.id, { saved: true, remindAt: new Date(Date.now() - 1000).toISOString() });
  const timers = await runMessageTimers(new Date());
  check(timers.reminded >= 1, "a saved message's reminder comes", timers);
  await posts.saveDraft(ids.bob, { channelId: design, body: "half written" });
  check((await bootstrap(ids.bob, workspaceId)).drafts!.some((d) => d.body === "half written"), "drafts are kept on the server");
  const found = await searchMessages(ids.bob, workspaceId, { query: "every" });
  check(found.messages.some((m) => m.id === root.id), "search finds by word prefix", found.messages.map((m) => m.body));
  check(!(await searchMessages(ids.owner, workspaceId, { query: "secret" })).messages.length, "search leaves out channels one can't read");
  check((await searchMessages(ids.bob, workspaceId, { has: ["pin"] })).messages.every((m) => m.pinnedAt), "search by what a message has");

  // ------------------------------------------------------------------ scheduled
  const scheduled = await scheduleMessage(ids.bob, { channelId: design, body: "later", sendAt: new Date(Date.now() + 1000).toISOString() });
  await runMessageTimers(new Date());
  check(!(await db.select().from(channelMessage).where(eq(channelMessage.id, scheduled))).length, "a scheduled message waits for its time");
  await runMessageTimers(new Date(Date.now() + 5000));
  const [out] = await db.select().from(channelMessage).where(eq(channelMessage.id, scheduled));
  check(out?.body === "later" && out.authorId === ids.bob, "and goes out as its writer then");

  // ------------------------------------------------------------------ sync
  const before = (await bootstrap(ids.bob, workspaceId)).rev;
  const late = (await posts.sendMessage(ids.ann, { channelId: design, body: "while you were away", id: crypto.randomUUID() })).message;
  await channels.leaveChannel(ids.bob, secret);
  const caught = await sync(ids.bob, workspaceId, before);
  check(!caught.reset && caught.messages?.some((m) => m.id === late.id), "sync brings messages sent while away", caught);
  check(!caught.reset && !caught.keep.memberships.includes(secret), "and shows which memberships are gone");
  check(!caught.reset && !caught.keep.channels.includes(secret), "and channels no longer seen");
  check((await sync(ids.bob, workspaceId, before + 10_000)).reset, "a cursor from the future answers reset");

  // ------------------------------------------------------------------ settings
  await channels.setPreferences(ids.bob, design, { muted: true, starred: true });
  const prefs = await membership(ids.bob, design);
  check(prefs?.muted && prefs.starred, "muting and starring a channel");
  await channels.setArchived(ids.ann, design, true);
  check(await refused(() => posts.sendMessage(ids.bob, { channelId: design, body: "x", id: crypto.randomUUID() }), "archived"), "an archived channel takes no messages");
  check(await refused(() => channels.setArchived(ids.bob, general.id, true)), "only a channel's admins archive it");

  for (const c of connections) removeConnection(c);
  console.log(`\n${passed} checks passed`);
} finally {
  for (const c of connections) removeConnection(c);
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  process.exit(process.exitCode ?? 0);
}
