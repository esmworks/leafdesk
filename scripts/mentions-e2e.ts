/**
 * End-to-end check of mentions and page links: Markdown in and out, notifying mentioned people once
 * (and only if they can open the page), live and access-checked titles of mentioned pages,
 * backlinks, reminders on dates, copies, published pages, the MCP tools and a browser's edits.
 * Creates its own users and workspace and deletes them afterwards.
 *
 *   pnpm tsx scripts/mentions-e2e.ts
 *
 * Env: DATABASE_URL (read from .env when present). Migrations must be applied.
 */
export {};

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { and, eq, inArray } = await import("drizzle-orm");
const Y = await import("yjs");
const { db } = await import("@/db");
const { notification, page, pageLink, pageMention, pageReminder, user, workspace, workspaceMember } = await import("@/db/schema");
const { COLLAB_FRAGMENT } = await import("@/lib/collab-constants");
const { eachMention, MENTION } = await import("@/lib/mentions");
const { getCollab, registerCollab } = await import("@/server/collab/bridge");
const { createCollab } = await import("@/server/collab/service");
const { serverEditor } = await import("@/server/blocknote");
const { archivePage, createPage, renamePage } = await import("@/server/pages");
const { duplicatePage } = await import("@/server/duplicate");
const { setPagePermission } = await import("@/server/permissions");
const { flushShareEmails, setShareMailer } = await import("@/server/share-emails");
const { deliverDueReminders, listBacklinks, mentionCandidates, resolvePageRefs } = await import("@/server/mentions");
const { listNotifications } = await import("@/server/notifications");
const { getPublishedPage, publishPage } = await import("@/server/publication");
const { AccessError } = await import("@/server/access");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { createServer } = await import("node:http");
const crossws = (await import("crossws/adapters/node")).default;
const { HocuspocusProvider } = await import("@hocuspocus/provider");
const { issueCollabToken } = await import("@/server/collab/token");
const { createMcpServer } = await import("@/server/mcp/tools");
const { READ_SCOPE, WRITE_SCOPE } = await import("@/server/mcp/principal");

const RUN = `mentions-e2e-${Date.now().toString(36)}`;

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

async function failure(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (error instanceof AccessError) return "access";
    throw error;
  }
}

/** Calls an MCP tool as `userId`, the way a connected AI app would. */
async function callTool(userId: string, name: string, args: Record<string, unknown>, scopes = [READ_SCOPE, WRITE_SCOPE]) {
  const server = createMcpServer({ userId, clientId: `${RUN}-client`, scopes });
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
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mentions-e2e", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

/** The mentions of a page's body, as stored. */
async function mentionsOf(pageId: string) {
  const { blocks } = await getCollab().readBlocks(pageId);
  const out: Record<string, string>[] = [];
  eachMention(blocks as never[], (m) => out.push({ ...m }));
  return out;
}

const mentionNotes = (userId: string, pageId: string) =>
  db
    .select()
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.kind, "mention"), eq(notification.pageId, pageId)));

const ids = {
  owner: `${RUN}-owner`,
  editor: `${RUN}-editor`,
  reader: `${RUN}-reader`,
  outsider: `${RUN}-outsider`,
};
const userIds = Object.values(ids);
const workspaceId = `${RUN}-ws`;
const otherWorkspace = `${RUN}-ws2`;
const mails: { to: string; subject: string; text: string }[] = [];
setShareMailer(async (mail) => void mails.push(mail));
const link = (pageId: string, text = "x") => `[${text}](/w/${workspaceId}/p/${pageId})`;

try {
  await db.insert(user).values(userIds.map((id) => ({ id, name: id, email: `${id}@example.test` })));
  await db.insert(workspace).values([
    { id: workspaceId, name: RUN },
    { id: otherWorkspace, name: `${RUN}-2` },
  ]);
  await db.insert(workspaceMember).values([
    { workspaceId, userId: ids.owner, role: "owner" },
    { workspaceId, userId: ids.editor, role: "member" },
    { workspaceId, userId: ids.reader, role: "member" },
    { workspaceId: otherWorkspace, userId: ids.outsider, role: "owner" },
  ]);
  const owner = { userId: ids.owner };
  const plan = await createPage(owner, { workspaceId, title: "Plan" });
  const target = await createPage(owner, { workspaceId, title: "Roadmap" });
  const secret = await createPage(owner, { workspaceId, title: "Secret layoffs" });
  const gone = await createPage(owner, { workspaceId, title: "Old notes" });
  const elsewhere = await createPage({ userId: ids.outsider }, { workspaceId: otherWorkspace, title: "Other workspace page" });
  // Only the owner can open the secret page.
  await setPagePermission(ids.owner, secret.id, ids.owner, "full");
  await setPagePermission(ids.owner, secret.id, null, "none");

  // Writing mentions as Markdown
  const body = `Ask @${ids.editor} about ${link(target.id, "whatever")} and ${link(secret.id)}, see ${link(gone.id)} by @2026-10-01.\n\n${link(target.id)} <!-- leafdesk:page-link -->`;
  await getCollab().replaceContent(plan.id, body, owner);
  const mentions = await mentionsOf(plan.id);
  check(
    mentions.map((m) => `${m.kind}:${m.userId || m.pageId || m.date}`).join(" ") ===
      `user:${ids.editor} page:${target.id} page:${secret.id} page:${gone.id} date:2026-10-01`,
    "Markdown becomes person, page and date mentions",
    mentions,
  );
  check(mentions.every((m) => m.kind === "page" || m.id), "person and date mentions get ids", mentions);
  const { blocks } = await getCollab().readBlocks(plan.id);
  check((blocks as { type: string }[]).some((b) => b.type === "pageLink"), "a page-link line becomes a Link to page block", blocks);
  const stored = (await getCollab().readPage(plan.id)).markdown;
  check(
    stored.includes(`[page](/w/${workspaceId}/p/${target.id})`) && !stored.includes("Roadmap") && !stored.includes("Secret"),
    "the stored Markdown names no page titles",
    stored,
  );
  check(stored.includes(`@${ids.editor}`) && stored.includes("@2026-10-01") && stored.includes("<!-- leafdesk:page-link -->"), "…and writes people, dates and page links", stored);

  // [[Title]] written out links to the page of that title the writer can see
  const wiki = await createPage(owner, { workspaceId, title: "Wiki notes" });
  await getCollab().replaceContent(wiki.id, "See [[roadmap]], [[Secret layoffs]], `[[Roadmap]]`, [[Wiki notes]] and [[Nowhere]].", {
    userId: ids.editor,
  });
  const wikiText = (await getCollab().readPage(wiki.id)).text;
  check(
    (await mentionsOf(wiki.id)).map((m) => m.pageId).join() === target.id &&
      ["[[Secret layoffs]]", "[[Roadmap]]", "[[Wiki notes]]", "[[Nowhere]]"].every((t) => wikiText.includes(t)) &&
      !wikiText.includes("[[roadmap]]"),
    "[[Title]] in written Markdown links the page, not one the writer can't see, the page itself, code or no page",
    { mentions: await mentionsOf(wiki.id), wikiText },
  );
  await getCollab().appendContent(wiki.id, "Also [[Secret layoffs]].", owner);
  check(
    (await mentionsOf(wiki.id)).map((m) => m.pageId).join() === [target.id, secret.id].join() &&
      (await getCollab().readPage(wiki.id)).text.includes("[[Secret layoffs]]"),
    "…appended Markdown too, for a writer who sees the page (what was there before stays)",
    await mentionsOf(wiki.id),
  );
  // Out of the way of the backlink counts below.
  await archivePage(ids.owner, wiki.id);

  // Backlinks
  const links = await db.select().from(pageLink).where(eq(pageLink.sourceId, plan.id));
  check(links.map((l) => l.targetId).sort().join() === [target.id, secret.id, gone.id].sort().join(), "saving the page records its links once each", links);
  check((await listBacklinks(ids.editor, target.id)).map((b) => b.id).join() === plan.id, "the target lists the page linking to it");
  const hidden = await createPage(owner, { workspaceId, title: "Hidden source" });
  await getCollab().replaceContent(hidden.id, `Also see ${link(target.id)}`, owner);
  await setPagePermission(ids.owner, hidden.id, ids.owner, "full");
  await setPagePermission(ids.owner, hidden.id, null, "none");
  check((await listBacklinks(ids.owner, target.id)).length === 2, "backlinks list every linking page for people who see them all");
  check(
    (await listBacklinks(ids.editor, target.id)).map((b) => b.id).join() === plan.id,
    "…and leave out pages the viewer can't open",
    await listBacklinks(ids.editor, target.id),
  );
  check((await failure(() => listBacklinks(ids.editor, secret.id))) === "access", "a page's backlinks need access to the page");
  await getCollab().replaceContent(hidden.id, "No links anymore.", owner);
  check((await listBacklinks(ids.owner, target.id)).length === 1, "removing a link removes the backlink");

  // Live titles, access and broken links
  await archivePage(ids.owner, gone.id);
  await renamePage(owner, target.id, "Roadmap v2");
  const refs = await resolvePageRefs(ids.editor, [target.id, secret.id, gone.id, elsewhere.id, "no-such-page"]);
  check(refs[0].status === "ok" && refs[0].title === "Roadmap v2", "a mentioned page shows its current title", refs[0]);
  check(refs[1].status === "noAccess" && !("title" in refs[1]), "a page the viewer can't open shows as no access, without its title", refs[1]);
  check(refs[2].status === "deleted", "a page in the trash shows as deleted", refs[2]);
  check(refs[3].status === "noAccess" && refs[4].status === "deleted", "…and pages elsewhere or gone don't leak", refs);

  // Notifying people
  let notes = await mentionNotes(ids.editor, plan.id);
  check(notes.length === 1 && notes[0].actorId === ids.owner && notes[0].emailDueAt !== null, "a mentioned person is notified, with an email queued", notes);
  check((await mentionNotes(ids.owner, plan.id)).length === 0, "mentioning yourself notifies no one");
  const markdown = (await getCollab().readPage(plan.id)).markdown;
  await getCollab().replaceContent(plan.id, markdown, owner);
  await getCollab().replaceContent(plan.id, `${markdown}\n\nEdited again.`, owner);
  notes = await mentionNotes(ids.editor, plan.id);
  check(notes.length === 1, "saving the page again doesn't notify again", notes);
  check(
    JSON.stringify((await mentionsOf(plan.id)).map((m) => m.id)) === JSON.stringify(mentions.map((m) => m.id)),
    "writing the Markdown back keeps each mention's id",
  );
  await flushShareEmails();
  const mentionMail = mails.filter((m) => m.to === `${ids.editor}@example.test` && m.subject.includes("mentioned you"));
  check(mentionMail.length === 1 && mentionMail[0].subject.includes("Plan"), "the mention email names the page", mentionMail);

  await getCollab().replaceContent(secret.id, `Don't tell @${ids.reader}.`, owner);
  check((await mentionNotes(ids.reader, secret.id)).length === 0, "people who can't open the page aren't notified");
  const secretMentions = await db.select().from(pageMention).where(eq(pageMention.pageId, secret.id));
  check(secretMentions.length === 1, "…but the mention is remembered, so gaining access later doesn't notify");

  await getCollab().appendContent(plan.id, `One more thing, @${ids.editor}.`, owner);
  notes = await mentionNotes(ids.editor, plan.id);
  const newest = (await mentionsOf(plan.id)).filter((m) => m.kind === "user").at(-1)!;
  check(notes.length === 1 && notes[0].mentionId === newest.id && notes[0].readAt === null, "a new mention moves the unread notification up", notes);
  await getCollab().replaceContent(plan.id, markdown, owner);
  notes = await mentionNotes(ids.editor, plan.id);
  check(notes.length === 0, "taking a mention out before it was read takes its notification back", notes);
  await getCollab().appendContent(plan.id, `Back again, @${ids.editor}.`, owner);
  check((await mentionNotes(ids.editor, plan.id)).length === 1, "…and mentioning them again notifies them again");
  await db.update(notification).set({ readAt: new Date() }).where(and(eq(notification.userId, ids.editor), eq(notification.kind, "mention")));
  const inbox = await listNotifications(ids.editor, { workspaceId });
  check(inbox.some((n) => n.kind === "mention" && n.pageId === plan.id), "mentions show in the inbox", inbox);

  // Reminders
  const setReminder = async (remindAt: string, as = ids.owner) => {
    const conn = await hocuspocus.openDirectConnection(`page:${plan.id}`, { userId: as });
    try {
      conn.document!.transact(() => {
        const walk = (node: InstanceType<typeof Y.XmlFragment> | InstanceType<typeof Y.XmlElement>) => {
          for (const child of node.toArray()) {
            if (!(child instanceof Y.XmlElement)) continue;
            if (child.nodeName === MENTION && child.getAttribute("kind") === "date") child.setAttribute("remindAt", remindAt);
            walk(child);
          }
        };
        walk(conn.document!.getXmlFragment(COLLAB_FRAGMENT));
      });
    } finally {
      await conn.disconnect();
    }
  };
  const reminders = () => db.select().from(pageReminder).where(eq(pageReminder.pageId, plan.id));
  await setReminder(new Date(Date.now() + 60 * 60_000).toISOString());
  let rows = await reminders();
  check(rows.length === 1 && rows[0].userId === ids.owner && rows[0].date === "2026-10-01" && rows[0].notifiedAt === null, "setting a reminder records it for whoever set it", rows);
  check((await deliverDueReminders()) === 0 || !(await reminders())[0].notifiedAt, "a reminder isn't sent before its time");
  await getCollab().replaceContent(plan.id, (await getCollab().readPage(plan.id)).markdown, owner);
  check((await mentionsOf(plan.id)).find((m) => m.kind === "date")?.remindAt, "writing the Markdown back keeps the date's reminder");
  const soon = new Date(Date.now() - 1000).toISOString();
  await setReminder(soon, ids.editor);
  rows = await reminders();
  check(rows.length === 1 && rows[0].userId === ids.editor && rows[0].notifiedAt === null, "changing a reminder moves it to whoever changed it", rows);
  check((await deliverDueReminders()) >= 1, "a due reminder is sent");
  check((await deliverDueReminders()) === 0 || (await reminders())[0].notifiedAt !== null, "…once");
  const reminderNotes = await db
    .select()
    .from(notification)
    .where(and(eq(notification.userId, ids.editor), eq(notification.kind, "reminder"), eq(notification.pageId, plan.id)));
  check(reminderNotes.length === 1 && reminderNotes[0].emailDueAt !== null, "it lands in the inbox, with an email", reminderNotes);
  const editorInbox = await listNotifications(ids.editor, { workspaceId });
  check(editorInbox.find((n) => n.kind === "reminder")?.reminderDate === "2026-10-01", "the inbox shows the reminder's date", editorInbox);
  mails.length = 0;
  await flushShareEmails();
  check(mails.some((m) => m.to === `${ids.editor}@example.test` && m.subject.startsWith("Reminder")), "the reminder email goes out", mails);
  await setReminder(new Date(Date.now() - 24 * 60 * 60_000).toISOString());
  rows = await reminders();
  check(rows.length === 1 && rows[0].notifiedAt !== null, "a reminder set in the past is kept but never sent", rows);
  await setReminder(new Date(Date.now() + 2 * 60 * 60_000).toISOString());
  await getCollab().replaceContent(plan.id, `Ask @${ids.editor} again later.`, owner);
  check((await reminders()).length === 0, "removing the date removes its unsent reminder");
  await getCollab().replaceContent(plan.id, markdown, owner);

  // The @ menu
  const menu = await mentionCandidates(ids.editor, plan.id, "road");
  check(menu.pages.map((p) => p.id).join() === target.id, "the @ menu finds pages by title", menu);
  const light = await createPage(owner, { workspaceId, title: "Işık planı" });
  const izmir = await createPage(owner, { workspaceId, title: "İzmir notları" });
  const found = async (query: string) => (await mentionCandidates(ids.editor, plan.id, query)).pages.map((p) => p.id);
  check(
    (await found("ışık")).includes(light.id) && (await found("IŞIK PL")).includes(light.id) && (await found("izmir")).includes(izmir.id) && (await found("İZMİR")).includes(izmir.id),
    "…with the dotted and dotless i either way",
  );
  check((await found("%")).length === 0 && (await found("_")).length === 0, "…taking % and _ as written");
  await db.delete(page).where(inArray(page.id, [light.id, izmir.id]));
  const secretSearch = await mentionCandidates(ids.editor, plan.id, "secret");
  check(secretSearch.pages.length === 0, "…never pages the user can't open", secretSearch);
  check((await mentionCandidates(ids.editor, plan.id, ids.reader.slice(-6))).people.some((p) => p.id === ids.reader), "…and finds people of the workspace");
  check((await failure(() => mentionCandidates(ids.outsider, plan.id, ""))) === "access", "…only for people who may edit the page");

  // Copies
  await setReminder(new Date(Date.now() + 3 * 60 * 60_000).toISOString());
  const before = (await db.select().from(notification).where(eq(notification.kind, "mention"))).length;
  const copy = await duplicatePage(owner, plan.id, " (copy)");
  const copied = await mentionsOf(copy.id);
  check(copied.some((m) => m.kind === "user"), "a copy keeps its mentions", copied);
  check((await db.select().from(notification).where(eq(notification.kind, "mention"))).length === before, "…without notifying the people in them again");
  check((await listBacklinks(ids.owner, target.id)).some((b) => b.id === copy.id), "…shows up in backlinks right away");
  check(copied.find((m) => m.kind === "date")?.remindAt === "", "…and starts without the source's reminders", copied);
  check((await db.select().from(pageReminder).where(eq(pageReminder.pageId, copy.id))).length === 0, "…so none are recorded for it");

  // MCP
  let r = await callTool(ids.editor, "get_page", { page_id: plan.id }, [READ_SCOPE]);
  check(
    !r.isError && r.data.markdown.includes(`[Roadmap v2](/w/${workspaceId}/p/${target.id})`) && r.data.markdown.includes(`[No access](/w/${workspaceId}/p/${secret.id})`),
    "get_page shows mentioned pages by current title, or as no access",
    r.data?.markdown,
  );
  check(!r.text.includes("Secret layoffs") && r.data.markdown.includes(`[Deleted page]`), "…never naming what the reader can't open", r.data.markdown);
  r = await callTool(ids.editor, "get_page", { page_id: target.id }, [READ_SCOPE]);
  check(
    r.data?.linked_from?.map((b: { id: string }) => b.id).sort().join() === [plan.id, copy.id].sort().join(),
    "get_page lists the pages linking to a page",
    r.data?.linked_from,
  );
  const read = (await callTool(ids.editor, "get_page", { page_id: plan.id }, [READ_SCOPE])).data.markdown as string;
  const idsBefore = (await mentionsOf(plan.id)).map((m) => `${m.kind}:${m.id}:${m.pageId}`);
  const notesBefore = (await db.select().from(notification).where(eq(notification.kind, "mention"))).length;
  r = await callTool(ids.editor, "update_page", { page_id: plan.id, markdown: read });
  check(!r.isError, "update_page takes the Markdown get_page gave", r.text);
  check(
    JSON.stringify((await mentionsOf(plan.id)).map((m) => `${m.kind}:${m.id}:${m.pageId}`)) === JSON.stringify(idsBefore),
    "…and writing it back changes no mention",
    await mentionsOf(plan.id),
  );
  check((await db.select().from(notification).where(eq(notification.kind, "mention"))).length === notesBefore, "…nor notifies anyone");
  r = await callTool(ids.editor, "update_page", { page_id: target.id, markdown: `Owned by @${ids.owner}.`, mode: "append" });
  check(!r.isError && (await mentionNotes(ids.owner, target.id)).length === 1, "an AI app mentioning someone notifies them, as the user it acts for", r.text);
  check((await mentionNotes(ids.owner, target.id))[0].actorId === ids.editor, "…naming that user");

  // Published pages
  const published = await publishPage(ids.owner, plan.id);
  let view = await getPublishedPage(published.token);
  let html = view?.body.map((b) => (b.kind === "html" ? b.html : "")).join("") ?? "";
  check(html.includes("Roadmap v2") && !html.includes(`/w/${workspaceId}`), "a published page shows unpublished mentioned pages as plain text", html);
  check(html.includes(`@${ids.editor}`) && html.includes("@2026-10-01"), "…and people and dates as text", html);
  const targetPublication = await publishPage(ids.owner, target.id);
  view = await getPublishedPage(published.token);
  html = view?.body.map((b) => (b.kind === "html" ? b.html : "")).join("") ?? "";
  check(html.includes(`href="/s/${targetPublication.token}"`), "…and published ones as links to them", html);

  // A browser's edit
  const ws = crossws({
    hooks: {
      open(peer) {
        (peer as unknown as { hp: ReturnType<typeof hocuspocus.handleConnection> }).hp = hocuspocus.handleConnection(
          peer.websocket as never,
          peer.request as Request,
        );
      },
      message(peer, message) {
        (peer as unknown as { hp?: { handleMessage(m: Uint8Array): void } }).hp?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        (peer as unknown as { hp?: { handleClose(e: unknown): void } }).hp?.handleClose({ code: event.code, reason: event.reason });
      },
    },
  });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => ws.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const browserDoc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: `page:${target.id}`,
    document: browserDoc,
    token: issueCollabToken(ids.editor, ids.editor),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the browser never synced")), 5000);
      provider.on("synced", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const current = serverEditor.yXmlFragmentToBlocks(browserDoc.getXmlFragment(COLLAB_FRAGMENT));
    browserDoc.transact(() =>
      serverEditor.blocksToYXmlFragment(
        [
          ...current,
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ping ", styles: {} },
              { type: "mention", props: { kind: "user", id: `${RUN}-browser-mention`, userId: ids.reader, name: ids.reader } },
            ],
          },
        ] as never,
        browserDoc.getXmlFragment(COLLAB_FRAGMENT),
      ),
    );
    let got: (typeof notification.$inferSelect)[] = [];
    for (let i = 0; i < 100 && !got.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      got = await mentionNotes(ids.reader, target.id);
    }
    check(got.length === 1 && got[0].actorId === ids.editor && got[0].mentionId === `${RUN}-browser-mention`, "a mention typed in a browser notifies, as the person who typed it", got);
  } finally {
    provider.destroy();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${passed} checks passed`);
} finally {
  setShareMailer(null);
  hocuspocus.closeConnections();
  await db.delete(workspace).where(inArray(workspace.id, [workspaceId, otherWorkspace]));
  await db.delete(user).where(inArray(user.id, userIds));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
}

// Nothing is left open, yet the process sometimes stays up after the websocket part (seen with
// empty active handles); end it explicitly, like mcp-e2e does. A failure above throws before this.
process.exit(0);
