/**
 * Takes the board screenshots the README and the website show, from a small workspace this script
 * makes ("Acme Inc."): a board of nine launch tasks with the workspace's pages beside it, in the
 * light and the dark scheme, in headless Chrome against a running server. Run it again after the
 * interface's look changes.
 *
 *   pnpm build && pnpm start          # one terminal
 *   pnpm tsx scripts/screenshots.ts   # another
 *
 * Writes .github/screenshots/board-{light,dark}.png (1440×900 at 2×, the README) and
 * site/img/board-{light,dark}.jpg (1600×1000, the website); scripts/social-preview.ts makes the
 * social preview images. The workspace is made again on each run; its owner is
 * screenshots@example.test, who can't sign in (the script makes the session). The script writes
 * the new pages' live documents itself, which is safe with the server running: no one has them
 * open yet.
 *
 * Env: APP_URL (default http://localhost:3000), DATABASE_URL and BETTER_AUTH_SECRET (read from .env
 * when present; the server's own), CHROME_PATH (default: Google Chrome on macOS).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSignature } from "better-auth/crypto";

try {
  process.loadEnvFile();
} catch {}

// Imported after .env is loaded: the database client reads DATABASE_URL when it is created.
const { eq, inArray, sql } = await import("drizzle-orm");
const { db } = await import("@/db");
const { session, user, workspace, workspaceMember } = await import("@/db/schema");
const { env } = await import("@/lib/env");
const { createCollab } = await import("@/server/collab/service");
const { registerCollab } = await import("@/server/collab/bridge");
const { createPage } = await import("@/server/pages");
const { addProperty, addView, getProperties, insertRows } = await import("@/server/databases");
const { createWorkspace } = await import("@/server/workspaces");

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
  socket.close();
} finally {
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
  await db.delete(session).where(eq(session.id, sessionRowId));
  await (globalThis as unknown as { __leafdeskSql?: { end(): Promise<void> } }).__leafdeskSql?.end();
  rmSync(profile, { recursive: true, force: true });
}
