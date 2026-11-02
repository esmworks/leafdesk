/**
 * Takes the screenshots the README and the website show, from a small workspace this script makes
 * ("Acme Inc."): a board of nine launch tasks with the workspace's pages beside it, and the Mail
 * tab with a customer's thread open, in the light and the dark scheme, in headless Chrome against a
 * running server. Run it again after the interface's look changes.
 *
 *   pnpm build && MAIL_ALLOWED_HOSTS=127.0.0.1 pnpm start   # one terminal
 *   pnpm tsx scripts/screenshots.ts                         # another
 *
 * Writes .github/screenshots/{board,mail}-{light,dark}.png (1440×900 at 2×, the README) and
 * site/img/{board,mail}-{light,dark}.jpg (1600×1000, the website); scripts/social-preview.ts makes the
 * social preview images. The workspace is made again on each run; its owner is
 * screenshots@example.test, who can't sign in (the script makes the session). The script writes
 * the new pages' live documents itself, which is safe with the server running: no one has them
 * open yet. The Mail tab's shots read a mailbox on GreenMail (greenmail/standalone:2.1.14, started
 * here with Docker on free ports and removed at the end), which MAIL_ALLOWED_HOSTS lets the server
 * reach.
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL and BETTER_AUTH_SECRET (read from .env
 * when present; the server's own), CHROME_PATH (default: Google Chrome on macOS).
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSignature } from "better-auth/crypto";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer";

try {
  process.loadEnvFile();
} catch {}
// Connecting the mailbox checks its server here too.
process.env.MAIL_ALLOWED_HOSTS = "127.0.0.1";

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { mailbox, session, user, workspace, workspaceMember } = await import("@/db/schema");
const { env } = await import("@/lib/env");
const { createCollab } = await import("@/server/collab/service");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { addProperty, addView, getProperties, insertRows } = await import("@/server/databases");
const { createWorkspace, updateWorkspaceSettings } = await import("@/server/workspaces");
const { connectMailbox } = await import("@/server/row-mail/settings");

const BASE = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OWNER = "screenshots-owner";
const root = new URL("..", import.meta.url).pathname;

// The pages write their own live documents, as the app's do.
const { service } = createCollab();
registerCollab(service);

// ---------------------------------------------------------------------------------------------
// The workspace.

const PAGES: { title: string; icon: string; markdown: string }[] = [
  {
    title: "Welcome to Acme",
    icon: "👋",
    markdown: "Start here: who we are, how we work and where things live.\n\n- Ask in the team chat when something is unclear.\n- Write decisions down where others will look for them.\n",
  },
  { title: "Engineering wiki", icon: "📚", markdown: "## Getting set up\n\nClone the repository, copy `.env.example` to `.env` and run `pnpm dev`.\n" },
  { title: "Meeting notes", icon: "🗒️", markdown: "## Weekly sync\n\n- [ ] Review the launch checklist\n- [ ] Pick a date for the beta\n" },
];
const LAST_PAGE = { title: "Customer feedback", icon: "💬", markdown: "What customers asked for this month, grouped by theme.\n" };

const PRIORITY = { Low: "orange", Medium: "brown", High: "gray" } as const;
const TAGS = { Marketing: "gray", Engineering: "brown", Web: "yellow", Docs: "green", Design: "orange" } as const;
type Task = { title: string; status: "Not started" | "In progress" | "Done"; priority: keyof typeof PRIORITY; due: string; tags: (keyof typeof TAGS)[] };
const TASKS: Task[] = [
  { title: "Record product demo video", status: "Not started", priority: "Medium", due: "2026-10-09", tags: ["Marketing"] },
  { title: "Set up status page", status: "Not started", priority: "Low", due: "2026-10-12", tags: ["Engineering"] },
  { title: "Accessibility audit", status: "Not started", priority: "High", due: "2026-10-10", tags: ["Design", "Web"] },
  { title: "Write launch announcement", status: "In progress", priority: "High", due: "2026-10-06", tags: ["Marketing"] },
  { title: "Finalize pricing page", status: "In progress", priority: "High", due: "2026-10-03", tags: ["Web"] },
  { title: "Onboarding email sequence", status: "In progress", priority: "Medium", due: "2026-10-07", tags: ["Marketing"] },
  { title: "Load test realtime server", status: "Done", priority: "High", due: "2026-09-25", tags: ["Engineering"] },
  { title: "Import guide for Notion users", status: "Done", priority: "Medium", due: "2026-09-24", tags: ["Docs"] },
  { title: "Mobile layout polish", status: "Done", priority: "Medium", due: "2026-09-26", tags: ["Design"] },
];

async function seed() {
  const previous = (await db.select({ id: workspaceMember.workspaceId }).from(workspaceMember).where(eq(workspaceMember.userId, OWNER))).map(
    (r) => r.id,
  );
  if (previous.length) await db.delete(workspace).where(inArray(workspace.id, previous));
  await db.delete(user).where(eq(user.id, OWNER));
  await db.insert(user).values({ id: OWNER, name: "Alex Morgan", email: "screenshots@example.test", emailVerified: true });
  const { id: workspaceId } = await createWorkspace(OWNER, "Acme Inc.");
  const owner = { userId: OWNER };
  for (const p of PAGES) await createPage(owner, { workspaceId, ...p }, { audit: false });
  const plan = await createPage(owner, { workspaceId, kind: "database", title: "Launch plan", icon: "🎯", seedProperties: false }, { audit: false });
  await createPage(owner, { workspaceId, ...LAST_PAGE }, { audit: false });

  await addProperty(OWNER, plan.id, { name: "Status", type: "status", options: ["Not started", "In progress", "Done"] });
  await addProperty(OWNER, plan.id, { name: "Owner", type: "person" });
  await addProperty(OWNER, plan.id, { name: "Priority", type: "select", options: Object.keys(PRIORITY) });
  await addProperty(OWNER, plan.id, { name: "Due", type: "date" });
  await addProperty(OWNER, plan.id, { name: "Tags", type: "multi_select", options: Object.keys(TAGS) });
  // The colors the options are shown in (new options take the next color in line).
  const recolor = async (name: string, colors: Record<string, string>) => {
    const prop = (await getProperties(plan.id)).find((p) => p.name === name)!;
    const options = prop.options.options!.map((o) => ({ ...o, color: colors[o.name] }));
    await db.execute(sql`update database_property set options = ${JSON.stringify({ options })}::jsonb where id = ${prop.id}`);
  };
  await recolor("Priority", PRIORITY);
  await recolor("Tags", TAGS);
  const props = await getProperties(plan.id);
  const prop = (name: string) => props.find((p) => p.name === name)!;
  const option = (name: string, value: string) => prop(name).options.options!.find((o) => o.name === value)!.id;
  const board = await addView(OWNER, plan.id, { name: "Board", type: "board", config: { groupBy: prop("Status").id } });
  await insertRows(
    { id: plan.id, workspaceId },
    OWNER,
    TASKS.map((task) => ({
      title: task.title,
      properties: {
        [prop("Status").id]: option("Status", task.status),
        [prop("Owner").id]: [OWNER],
        [prop("Priority").id]: option("Priority", task.priority),
        [prop("Due").id]: task.due,
        [prop("Tags").id]: task.tags.map((tag) => option("Tags", tag)),
      },
    })),
  );
  await db.execute(sql`delete from assignment_email where user_id = ${OWNER}`);
  // "Edited 2 minutes ago" in the page's header.
  await db.execute(sql`update page set updated_at = now() - interval '2 minutes' where id = ${plan.id}`);
  return { workspaceId, planId: plan.id, boardId: board.id };
}

// ---------------------------------------------------------------------------------------------
// The mailbox: Alex's inbox on a GreenMail server of its own, in a container removed at the end.

const MAIL_HOST = "127.0.0.1";
const MAIL_CONTAINER = "leafdesk-greenmail-screenshots";
const ALEX = "alex@acme.test";
const OPENED = "Re: Pricing for 40 seats";
const OPENED_TEXT = "That works for us.";
const SENT_TEXT = "Great to hear!";

type Mail = { from: string; subject: string; text: string; ago: number; seen?: boolean; starred?: boolean; id?: string; replyTo?: string; file?: string };
// `ago` in minutes before now; the list shows the newest first.
const INBOX: Mail[] = [
  {
    from: "Priya Shah <priya@northwind.test>",
    subject: "Pricing for 40 seats",
    text: "Hi Alex,\n\nThanks for the demo on Tuesday. The team loved the board view and the meeting notes.\n\nCould you send pricing for 40 seats on the yearly plan? We'd like to start before the end of the month.\n\nBest,\nPriya",
    ago: 26 * 60,
    seen: true,
    id: "pricing-1",
  },
  {
    from: "Priya Shah <priya@northwind.test>",
    subject: OPENED,
    text: `Hi Alex,\n\n${OPENED_TEXT} We'll sign this week and set up single sign-on with our IT team on Monday.\n\nCould you also share the onboarding checklist you mentioned? Our first teamspace will be Product.\n\nThanks again,\nPriya`,
    ago: 12,
    id: "pricing-3",
    replyTo: "pricing-2",
  },
  { from: "Jordan Lee <jordan@fabrikam.test>", subject: "Beta feedback: the new agenda view", text: "Hi Alex, we've been using the agenda view for a week now. A few notes from the team…", ago: 48, starred: true },
  { from: "Maria Garcia <maria@contoso.test>", subject: "Invoice #2041 for October", text: "Hello, please find our invoice for October attached. Payment is due in 30 days.", ago: 95, file: "Invoice-2041.pdf" },
  { from: "Sam Patel <sam@acme.test>", subject: "Launch day checklist", text: "Here's the list for Thursday: press kit, status page, the announcement and a quick check of the pricing page.", ago: 160, seen: true },
  { from: "Chen Wei <chen@tailspin.test>", subject: "Can we move Thursday's call?", text: "Something came up on Thursday afternoon. Would Friday at 10:00 work for you instead?", ago: 230, seen: true },
  { from: "The Product Weekly <news@productweekly.test>", subject: "Five ideas for faster onboarding", text: "This week: checklists that people finish, welcome pages that answer questions, and more.", ago: 6 * 60, seen: true },
  { from: "Lena Fischer <lena@woodgrove.test>", subject: "Contract draft v3", text: "Hi Alex, attached is the third draft with the changes from our call. The renewal terms are on page 4.", ago: 22 * 60, seen: true, starred: true, file: "Contract-v3.pdf" },
  { from: "Tom Becker <tom@acme.test>", subject: "Welcome aboard, Riley!", text: "Everyone, please welcome Riley, who joins the design team today.", ago: 30 * 60, seen: true },
];
const SENT: Mail = {
  from: `Alex Morgan <${ALEX}>`,
  subject: OPENED,
  text: `Hi Priya,\n\n${SENT_TEXT} For 40 seats on the yearly plan it's $8 per seat a month, so $3,840 a year, with single sign-on included.\n\nI can have your workspace ready tomorrow.\n\nAlex`,
  ago: 3 * 60,
  seen: true,
  id: "pricing-2",
  replyTo: "pricing-1",
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, MAIL_HOST, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const docker = (...args: string[]) => execFileSync("docker", args, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** Starts GreenMail, puts Alex's mail in it and connects it as Alex's mailbox in the workspace. */
async function seedMail(workspaceId: string) {
  const smtpPort = await freePort();
  const imapPort = await freePort();
  try {
    docker("rm", "-f", MAIL_CONTAINER);
  } catch {}
  docker(
    "run",
    "-d",
    "--name",
    MAIL_CONTAINER,
    "-p",
    `${MAIL_HOST}:${smtpPort}:3025`,
    "-p",
    `${MAIL_HOST}:${imapPort}:3143`,
    "-e",
    "GREENMAIL_OPTS=-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled",
    "greenmail/standalone:2.1.14",
  );
  const imap = () => new ImapFlow({ host: MAIL_HOST, port: imapPort, secure: false, auth: { user: ALEX, pass: "x" }, logger: false });
  let client = imap();
  for (let i = 0; ; i++) {
    try {
      await client.connect();
      break;
    } catch (error) {
      if (i === 60) throw error;
      await new Promise((r) => setTimeout(r, 500));
      client = imap();
    }
  }
  const raw = async (mail: Mail, to: string) => {
    const messageId = (id: string) => `<${id}@screenshots.acme.test>`;
    const parent = mail.replyTo ? messageId(mail.replyTo) : undefined;
    return new MailComposer({
      from: mail.from,
      to,
      subject: mail.subject,
      text: mail.text,
      date: new Date(Date.now() - mail.ago * 60_000),
      messageId: mail.id ? messageId(mail.id) : undefined,
      inReplyTo: parent,
      references: parent,
      attachments: mail.file ? [{ filename: mail.file, content: Buffer.from("%PDF-1.4\n%%EOF\n"), contentType: "application/pdf" }] : [],
    })
      .compile()
      .build();
  };
  const flags = (mail: Mail) => [...(mail.seen ? ["\\Seen"] : []), ...(mail.starred ? ["\\Flagged"] : [])];
  try {
    for (const name of ["Sent", "Drafts", "Archive", "Trash", "Junk"]) await client.mailboxCreate(name);
    for (const mail of INBOX) await client.append("INBOX", await raw(mail, `Alex Morgan <${ALEX}>`), flags(mail), new Date(Date.now() - mail.ago * 60_000));
    await client.append("Sent", await raw(SENT, "Priya Shah <priya@northwind.test>"), flags(SENT), new Date(Date.now() - SENT.ago * 60_000));
  } finally {
    await client.logout();
  }
  await updateWorkspaceSettings(OWNER, workspaceId, { email: true });
  const servers = { imapHost: MAIL_HOST, imapPort, imapSecure: false, smtpHost: MAIL_HOST, smtpPort, smtpSecure: false };
  await connectMailbox(OWNER, workspaceId, { address: ALEX, servers, username: ALEX, password: "x", consent: true, displayName: "Alex Morgan", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------------------------
// Headless Chrome over the DevTools protocol (Node's WebSocket, no dependencies), as sw-e2e does.

const profile = mkdtempSync(join(tmpdir(), "leafdesk-screenshots-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--hide-scrollbars",
  "--lang=en-US",
  "about:blank",
]);
const sessionToken = randomBytes(24).toString("hex");
const sessionRowId = `screenshots-session-${randomBytes(4).toString("hex")}`;

try {
  const { workspaceId, planId, boardId } = await seed();
  await db.insert(session).values({ id: sessionRowId, token: sessionToken, userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000), updatedAt: new Date() });

  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 15_000);
    chrome.stderr.on("data", (chunk: Buffer) => {
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on("exit", () => reject(new Error("Chrome exited")));
  });
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    const call = msg.id && pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve(msg.result);
  });
  const send = <T = Record<string, unknown>>(method: string, params: object = {}, sessionId?: string): Promise<T> => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  };
  const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const tab = <T = Record<string, unknown>>(method: string, params: object = {}) => send<T>(method, params, sessionId);
  const evaluate = async <T,>(expression: string): Promise<T> => {
    const { result, exceptionDetails } = await tab<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails));
    return result.value;
  };
  /** Waits until `expression` is true in the page. */
  const until = async (expression: string, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!(await evaluate<boolean>(expression).catch(() => false))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const cookie = `${sessionToken}.${await makeSignature(sessionToken, env.authSecret)}`;
  await tab("Network.enable");
  await tab("Network.setCookie", { name: "better-auth.session_token", value: encodeURIComponent(cookie), url: BASE, httpOnly: true, sameSite: "Lax" });
  // In English whatever this computer's language: the app takes the language from this cookie first.
  await tab("Network.setCookie", { name: "NEXT_LOCALE", value: "en", url: BASE, sameSite: "Lax" });
  await tab("Network.setExtraHTTPHeaders", { headers: { "Accept-Language": "en-US,en;q=0.9" } });
  await tab("Emulation.setLocaleOverride", { locale: "en-US" });
  // Whenever this runs, the newest mail came in the early afternoon: a fixed offset putting now at 3 pm.
  const offset = ((15 - new Date().getUTCHours() + 36) % 24) - 12;
  await tab("Emulation.setTimezoneOverride", { timezoneId: offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}` });

  /** The board, in this scheme and size, saved where `out` says. */
  async function board(scheme: "light" | "dark", scale: number, format: "png" | "jpeg", out: string) {
    await tab("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
    await tab("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    await tab("Page.navigate", { url: `${BASE}/w/${workspaceId}/p/${planId}?view=${boardId}` });
    await until(`document.querySelectorAll("[data-card]").length === ${TASKS.length} && document.fonts.status === "loaded"`, "the board's cards");
    // The live connection's dot, emoji images and the sidebar settle after the cards.
    await new Promise((r) => setTimeout(r, 2_000));
    const { data } = await tab<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 88 } : {}) });
    writeFileSync(join(root, out), Buffer.from(data, "base64"));
    console.log(`wrote ${out}`);
  }
  await board("light", 2, "png", ".github/screenshots/board-light.png");
  await board("dark", 2, "png", ".github/screenshots/board-dark.png");
  await board("light", 1600 / 1440, "jpeg", "site/img/board-light.jpg");
  await board("dark", 1600 / 1440, "jpeg", "site/img/board-dark.jpg");

  /** The Mail tab with Priya's thread open, in this scheme and size, saved where `out` says. */
  async function mail(scheme: "light" | "dark", scale: number, format: "png" | "jpeg", out: string) {
    await tab("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: scale, mobile: false });
    await tab("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    // The thread joins Alex's answer once the sent folder is read too, which may come after the inbox.
    for (let attempt = 1; ; attempt++) {
      await tab("Page.navigate", { url: `${BASE}/w/${workspaceId}/mail` });
      // The first read of the mailbox runs in the background as Mail lists it.
      await until(`document.querySelectorAll("[data-thread]").length === ${INBOX.length - 1}`, "the inbox's threads");
      await evaluate(`[...document.querySelectorAll("[data-thread]")].find((el) => el.textContent.includes(${JSON.stringify(OPENED)})).click()`);
      await until(`document.body.innerText.includes(${JSON.stringify(OPENED_TEXT)}) && document.fonts.status === "loaded"`, "the open thread");
      await new Promise((r) => setTimeout(r, 2_000));
      if (await evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(SENT_TEXT)})`)) break;
      if (attempt === 10) throw new Error("Alex's answer never joined the thread");
      await new Promise((r) => setTimeout(r, 3_000));
    }
    const { data } = await tab<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 88 } : {}) });
    writeFileSync(join(root, out), Buffer.from(data, "base64"));
    console.log(`wrote ${out}`);
  }
  // After the board's shots, whose sidebar would count the new mail.
  await seedMail(workspaceId);
  await mail("light", 2, "png", ".github/screenshots/mail-light.png");
  await mail("dark", 2, "png", ".github/screenshots/mail-dark.png");
  await mail("light", 1600 / 1440, "jpeg", "site/img/mail-light.jpg");
  await mail("dark", 1600 / 1440, "jpeg", "site/img/mail-dark.jpg");
  socket.close();
} finally {
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  await db.delete(session).where(eq(session.id, sessionRowId));
  // The server's sweeps would keep trying the mail server once it is gone.
  await db.delete(mailbox).where(eq(mailbox.userId, OWNER));
  try {
    docker("rm", "-f", MAIL_CONTAINER);
  } catch {}
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  rmSync(profile, { recursive: true, force: true });
}
