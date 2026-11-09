/**
 * End-to-end check of what reaches team messages from outside the app's own box, against the
 * database: a channel's webhooks (only admins make and delete them, the address works once copied,
 * wrong secrets, bad payloads, archived channels and makers who left are refused, the message has
 * no author and shows the webhook's name); link cards stored on a message (with a stand-in fetch),
 * kept away once the author removes them; the calls MCP and the REST API make (channels listed by
 * who may read them, a channel's and a thread's messages, search, sending as the person, refusals
 * for people outside); and the automation step that posts in a channel as its person, once, with
 * a link to the row. Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/message-extras-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied. Run it while no app
 * server uses the same database: the server's own automation worker would take the queued runs.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

const { and, eq, inArray, isNull } = await import("drizzle-orm");
const { db } = await import("@/db");
const { channelMessage, page, user, workspace, workspaceMember } = await import("@/db/schema");
const { registerCollab } = await import("@/server/collab/bridge");
const channels = await import("@/server/messages/channels");
const posts = await import("@/server/messages/posts");
const { bootstrap } = await import("@/server/messages/sync");
const { MessageError } = await import("@/server/messages/core");
const webhooks = await import("@/server/messages/webhooks");
const { forgetMessagePreviews, hidePreviews, previewMessageLinks } = await import("@/server/messages/link-previews");
const messageOps = await import("@/server/messages/operations");
const { AccessError } = await import("@/server/access");
const { ToolInputError } = await import("@/server/mcp/format");
const { API_ROUTES } = await import("@/server/api/routes");
const { addProperty, createRows } = await import("@/server/databases");
const { createPage } = await import("@/server/pages");
const manage = await import("@/server/automations/manage");
const { flushAutomations } = await import("@/server/automations/run");

const RUN = `message-extras-e2e-${Date.now().toString(36)}`;

registerCollab({
  async pagesTrashed() {},
  broadcast() {},
  async disconnectLostAccess() {},
  async replaceContent() {},
  async setTitle(pageId: string, title: string) {
    await db.update(page).set({ title }).where(eq(page.id, pageId));
  },
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

async function refusedWith(fn: () => Promise<unknown>, kind: abstract new (...args: never[]) => Error) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error instanceof kind;
  }
}

const ids = { owner: `${RUN}-owner`, ann: `${RUN}-ann`, bob: `${RUN}-bob`, outsider: `${RUN}-outsider` };
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const ctx = (userId: string) => ({ userId, actor: { userId } });
const messagesIn = (channelId: string) =>
  db.select().from(channelMessage).where(and(eq(channelMessage.channelId, channelId), eq(channelMessage.kind, "message"), isNull(channelMessage.deletedAt)));

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: `${id.split("-").at(-1)!} person`, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.ann, role: "member" },
    { workspaceId, userId: ids.bob, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  for (const id of [ids.owner, ids.ann, ids.bob]) await bootstrap(id, workspaceId);
  const alerts = await channels.createChannel(ids.ann, workspaceId, { name: "alerts", kind: "public" });
  const hidden = await channels.createChannel(ids.ann, workspaceId, { name: "hidden", kind: "private" });
  await channels.joinChannel(ids.bob, alerts);

  // ------------------------------------------------------------------ webhooks
  check(await refusedWith(() => webhooks.createWebhook(ids.bob, alerts, "CI"), MessageError), "a channel's member who isn't its admin can't add a webhook");
  check(await refusedWith(() => webhooks.createWebhook(ids.ann, alerts, "   "), MessageError), "a webhook needs a name");
  const hook = await webhooks.createWebhook(ids.ann, alerts, "  Build   bot ");
  check(hook.name === "Build bot" && hook.url.includes(`/api/messages/webhooks/${hook.id}/`), "an admin adds one and gets its address once", hook);
  const secret = hook.url.split("/").at(-1)!;
  check(hook.hint === secret.slice(-4), "…the list keeps only a hint of the secret");
  const listed = await webhooks.listWebhooks(ids.ann, alerts);
  check(listed.length === 1 && !("url" in listed[0]), "the list doesn't hold the address", listed);
  check(await refusedWith(() => webhooks.listWebhooks(ids.bob, alerts), MessageError), "…and only admins list them");

  const wrong = await webhooks.postFromWebhook(hook.id, `${secret}x`, { text: "hi" });
  check(wrong.status === 404 && wrong.text === "no_service", "a wrong secret answers no_service", wrong);
  const bad = await webhooks.postFromWebhook(hook.id, secret, { blocks: [] });
  check(bad.status === 400 && bad.text === "no_text", "a payload with nothing to say answers no_text", bad);
  const sent = await webhooks.postFromWebhook(hook.id, secret, {
    text: "fallback",
    blocks: [
      { type: "header", text: { type: "plain_text", text: "Deploy finished" } },
      { type: "section", text: { type: "mrkdwn", text: "*web* is live <https://ci.example.test/1|build 1>" } },
    ],
  });
  check(sent.status === 200 && sent.text === "ok", "a payload is posted", sent);
  const [fromHook] = (await messagesIn(alerts)).filter((m) => m.data?.webhook);
  check(fromHook && fromHook.authorId === null && fromHook.data?.webhook?.name === "Build bot", "…as a message without an author, showing the webhook's name", fromHook);
  check(fromHook.body === "### Deploy finished\n\n**web** is live [build 1](https://ci.example.test/1)", "…its blocks written as Markdown", fromHook.body);
  check((await webhooks.listWebhooks(ids.ann, alerts))[0].lastUsedAt !== null, "…and the webhook remembers when it posted");

  // The maker leaves: the webhook stops.
  await db.delete(workspaceMember).where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, ids.ann)));
  const orphan = await webhooks.postFromWebhook(hook.id, secret, { text: "still?" });
  check(orphan.status === 403 && orphan.text === "action_prohibited", "a webhook whose maker left the workspace posts no more", orphan);
  await db.insert(workspaceMember).values({ workspaceId, userId: ids.ann, role: "member" });

  const second = await webhooks.createWebhook(ids.owner, alerts, "Alerts");
  check(second.createdBy === ids.owner, "a workspace owner who may see the channel adds one too");
  await webhooks.deleteWebhook(ids.ann, second.id);
  const gone = await webhooks.postFromWebhook(second.id, second.url.split("/").at(-1)!, { text: "x" });
  check(gone.status === 404, "a deleted webhook's address stops working", gone);

  // ------------------------------------------------------------------ link cards
  const withLink = await posts.sendMessage(ids.bob, { channelId: alerts, body: "See https://docs.invalid/guide and `https://code.invalid/x`", id: crypto.randomUUID() });
  forgetMessagePreviews();
  const asked: string[] = [];
  await previewMessageLinks(withLink.message.id, async (url) => {
    asked.push(url);
    return { url, title: "The guide", description: "How it works", image: "", favicon: "", siteName: "Docs" };
  });
  check(asked.length === 1 && asked[0] === "https://docs.invalid/guide", "only links outside code are looked up", asked);
  let [stored] = await db.select().from(channelMessage).where(eq(channelMessage.id, withLink.message.id));
  check(stored.data?.previews?.[0]?.title === "The guide", "the card is stored on the message", stored.data);
  check(await refusedWith(() => hidePreviews(ids.ann, workspaceId, withLink.message.id), MessageError), "only the author removes the cards");
  await hidePreviews(ids.bob, workspaceId, withLink.message.id);
  [stored] = await db.select().from(channelMessage).where(eq(channelMessage.id, withLink.message.id));
  check(!stored.data?.previews && stored.data?.previewsHidden === true, "the author removes them", stored.data);
  await previewMessageLinks(withLink.message.id, async (url) => ({ url, title: "Again", description: "", image: "", favicon: "", siteName: "" }));
  [stored] = await db.select().from(channelMessage).where(eq(channelMessage.id, withLink.message.id));
  check(!stored.data?.previews, "…and they don't come back", stored.data);

  // ------------------------------------------------------------------ MCP and REST calls
  const listedFor = await messageOps.listChannels(ctx(ids.bob), { workspace_id: workspaceId });
  check(listedFor.channels.some((c) => c.id === alerts && c.member && c.name === "#alerts"), "channels are listed with whether the person is in them", listedFor);
  check(!listedFor.channels.some((c) => c.id === hidden), "a private channel they aren't in is left out");
  check(await refusedWith(() => messageOps.listChannels(ctx(ids.outsider), { workspace_id: workspaceId }), AccessError), "someone outside the workspace is refused");

  const replyTo = await messageOps.sendChannelMessage(ctx(ids.bob), { channel_id: alerts, text: "Is web healthy?" });
  check(replyTo.message.author === "bob person" && replyTo.message.url.includes(`c=${alerts}`), "a message is sent as the person, with its link", replyTo);
  await messageOps.sendChannelMessage(ctx(ids.ann), { channel_id: alerts, text: "Yes, all green", thread_id: replyTo.message.id });
  check(await refusedWith(() => messageOps.sendChannelMessage(ctx(ids.bob), { channel_id: hidden, text: "x" }), AccessError), "a channel the person can't see reads as not found");
  const general = (await bootstrap(ids.owner, workspaceId)).channels!.find((c) => c.kind === "public" && c.id !== alerts)!;
  await channels.leaveChannel(ids.bob, general.id);
  check(await refusedWith(() => messageOps.sendChannelMessage(ctx(ids.bob), { channel_id: general.id, text: "x" }), ToolInputError), "a public channel they left takes no messages from them");

  const page1 = await messageOps.readMessages(ctx(ids.owner), { channel_id: alerts, limit: 2 });
  check(page1.messages.length === 2 && page1.has_more && page1.next_before !== null, "a channel's messages come a page at a time", page1);
  check(page1.messages.at(-1)!.id === replyTo.message.id && page1.messages.at(-1)!.reply_count === 1, "…the newest last, with its reply count");
  const older = await messageOps.readMessages(ctx(ids.owner), { channel_id: alerts, before: page1.next_before!, limit: 10 });
  check(older.messages.some((m) => m.author === "Build bot" && m.via === "webhook"), "older messages include the webhook's, named as such", older.messages);
  const thread = await messageOps.readMessages(ctx(ids.owner), { channel_id: alerts, thread_id: replyTo.message.id });
  check(thread.thread?.id === replyTo.message.id && thread.messages.length === 1 && thread.messages[0].text === "Yes, all green", "a thread reads its replies", thread);
  check(await refusedWith(() => messageOps.readMessages(ctx(ids.outsider), { channel_id: alerts }), AccessError), "someone outside reads nothing");

  const found = await messageOps.searchMessages(ctx(ids.owner), { workspace_id: workspaceId, query: "healthy" });
  check(found.messages.length === 1 && found.messages[0].channel === "#alerts", "search finds a message by its words, naming its channel", found);
  check(await refusedWith(() => messageOps.searchMessages(ctx(ids.owner), { workspace_id: workspaceId }), ToolInputError), "a search needs words or a filter");

  const routes = new Map(API_ROUTES.map((r) => [`${r.method} ${r.path}`, r.scope]));
  check(
    routes.get("GET /workspaces/{workspace_id}/channels") === "messages:read" &&
      routes.get("GET /channels/{channel_id}/messages") === "messages:read" &&
      routes.get("GET /workspaces/{workspace_id}/messages/search") === "messages:read" &&
      routes.get("POST /channels/{channel_id}/messages") === "messages:write",
    "the REST API's message routes need the messages scopes",
  );

  // ------------------------------------------------------------------ the automation step
  const owner = { userId: ids.owner };
  const tasks = await createPage(owner, { workspaceId, kind: "database", title: "Tasks" });
  await addProperty(ids.owner, tasks.id, { name: "Note", type: "text" });
  await channels.joinChannel(ids.owner, alerts);
  check(
    await refusedWith(
      () => manage.createAutomation(ids.owner, tasks.id, { name: "x", trigger: { type: "row_created" }, actions: [{ type: "channel_message", channel: hidden, message: "x" }] }),
      Error,
    ),
    "the step refuses a channel its person can't post in",
  );
  const poster = await manage.createAutomation(ids.owner, tasks.id, {
    name: "Tell the channel",
    trigger: { type: "row_created" },
    actions: [{ type: "channel_message", channel: "#alerts", message: "New task: **{{trigger.title}}**" }],
  });
  check(poster.actions[0].type === "channel_message" && poster.actions[0].channelId === alerts, "a channel can be named by #name", poster.actions);
  const before = (await messagesIn(alerts)).length;
  const [row] = await createRows(ids.owner, tasks.id, [{ title: "Ship it" }]);
  await flushAutomations();
  const posted = (await messagesIn(alerts)).filter((m) => m.data?.automation?.id === poster.id);
  check(posted.length === 1 && (await messagesIn(alerts)).length === before + 1, "the automation posts once", posted);
  check(posted[0].authorId === ids.owner && posted[0].data?.automation?.name === "Tell the channel", "…as its person, naming the automation", posted[0]);
  check(posted[0].body.startsWith("New task: **Ship it**") && posted[0].body.includes(row.id), "…with the trigger's values and a link to the row", posted[0].body);

  console.log(`\n${passed} checks passed`);
} finally {
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  process.exit(process.exitCode ?? 0);
}
