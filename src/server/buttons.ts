import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { notification, user } from "@/db/schema";
import { resolveText, resolveValue, type TemplateScope } from "@/lib/automation-templates";
import { isDynamicValue, type StepValues } from "@/lib/automations";
import {
  BUTTON_BLOCK,
  BUTTON_CLICKS_PER_MINUTE,
  buttonScope,
  cleanButtonLabel,
  MAX_BUTTON_ROWS,
  parseButtonConfig,
  type ButtonStep,
  type ButtonStepType,
} from "@/lib/buttons";
import { env } from "@/lib/env";
import { parseImageLink } from "@/lib/image-links";
import { pageLabel } from "@/lib/labels";
import { PropertyValueError } from "@/lib/properties";
import { sharedLimiter, takeAll } from "@/lib/rate-limit";
import { isTimeZone } from "@/lib/time-zone";
import { AccessError, requirePageAccess, resolvePageAccess } from "@/server/access";
import { notAgentUser } from "@/server/agents/users";
import { coerceValue } from "@/server/automations/values";
import { sendWebhook, WebhookError, webhookSecret } from "@/server/automations/webhook";
import { runAsButton } from "@/server/button-press";
import { getCollab } from "@/server/collab/bridge";
import { createRows, getProperties, requireDatabase, updateRowProperties, viewedRows } from "@/server/databases";
import { createRow, rowTemplateInput } from "@/server/templates";
import { signalInbox } from "@/server/notifications";
import { pushNotifications } from "@/server/push";
import { exportAllowed, listMembers } from "@/server/workspaces";
import { avatarSrc } from "@/lib/avatar";
import { redactError } from "@/lib/redact";

/**
 * Buttons on pages (lib/buttons.ts): clicking one does its steps in order, as whoever clicked, each
 * checked against that person's access when it runs: opening the page is enough to click, and each
 * step needs what doing it by hand would (editing the page to insert blocks, editing a database to
 * add or change its rows). The first step that can't be done stops the button and says which and
 * why; the steps before it stay done, as if the person had done them one by one.
 *
 * The writes are the clicker's own edits: row changes start the database's automations as theirs
 * would (an automation's own writes start none, see automations/queue.ts, so a button and the
 * automations it starts can't go round in circles), and row activity marks them as made through a
 * button. Notices go to people who can open the page, in their inbox (and as push), from the
 * clicker; webhooks go out signed like automations', when the workspace lets content leave it.
 */

/** Why clicking a button did nothing at all. */
export type ButtonErrorCode = "notFound" | "noSteps" | "inTrash" | "rateLimited";

export class ButtonError extends Error {
  constructor(
    readonly code: ButtonErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ButtonError";
  }
}

/** Why a step couldn't be done (translated in the block as `page.button.failed.<code>`). */
export const BUTTON_STEP_FAILURES = [
  "noAccess",
  "locked",
  "notConfigured",
  "databaseGone",
  "invalidValue",
  "exportOff",
  "webhookFailed",
  "invalidTarget",
  "buttonGone",
  "templateGone",
  "error",
] as const;
export type ButtonStepFailure = (typeof BUTTON_STEP_FAILURES)[number];

class StepFailure extends Error {
  constructor(
    readonly code: ButtonStepFailure,
    message: string,
  ) {
    super(message);
  }
}

/** What clicking did: every step done (and what to open now), or the step that stopped it. */
export type ButtonPress =
  | { ok: true; done: number; open: { href: string; page: boolean } | null }
  | { ok: false; done: number; step: number; type: ButtonStepType; code: ButtonStepFailure };

type Block = { id?: string; type: string; props?: Record<string, unknown>; children?: Block[] };

function findBlock(blocks: Block[], blockId: string): Block | null {
  for (const block of blocks) {
    if (block.id === blockId) return block;
    const found = block.children?.length ? findBlock(block.children, blockId) : null;
    if (found) return found;
  }
  return null;
}

/** The button `blockId` of the page, as it is saved now. */
async function readButton(pageId: string, blockId: string) {
  const { blocks } = await getCollab().readBlocks(pageId);
  const block = findBlock(blocks as Block[], blockId);
  if (!block || block.type !== BUTTON_BLOCK) throw new ButtonError("notFound", "The page has no such button");
  return { label: cleanButtonLabel(block.props?.label), config: parseButtonConfig(block.props?.config) };
}

type Press = {
  userId: string;
  pageId: string;
  blockId: string;
  workspaceId: string;
  label: string;
  scope: TemplateScope & { today: string };
  timeZone: string;
};

/**
 * Clicks button `blockId` on page `pageId` for `userId`. `timeZone` is the clicker's (their
 * browser's), for `{{today}}`, `{{now}}` and "today" in dates. Throws ButtonError when nothing
 * could run and AccessError when they can't open the page.
 */
export async function pressButton(userId: string, pageId: string, blockId: string, { timeZone = "UTC" }: { timeZone?: string } = {}): Promise<ButtonPress> {
  const target = await requirePageAccess(userId, pageId, "view");
  if (target.archivedAt) throw new ButtonError("inTrash", "Buttons on pages in the trash do nothing");
  if (takeAll([[sharedLimiter("button", BUTTON_CLICKS_PER_MINUTE, 60_000), `${userId}:${pageId}:${blockId}`]]) > 0) {
    throw new ButtonError("rateLimited", "This button was clicked too often; wait a moment");
  }
  const { label, config } = await readButton(pageId, blockId);
  if (!config.steps.length) throw new ButtonError("noSteps", "This button does nothing yet");
  const zone = isTimeZone(timeZone) ? timeZone : "UTC";
  const [me] = await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, userId));
  const press: Press = {
    userId,
    pageId,
    blockId,
    workspaceId: target.workspaceId,
    label,
    scope: buttonScope(new Date(), zone, me ?? { id: userId, name: "", email: "" }),
    timeZone: zone,
  };

  return runAsButton(async () => {
    let open: { href: string; page: boolean } | null = null;
    for (const [index, step] of config.steps.entries()) {
      try {
        if (step.type === "open") open = openTarget(step);
        else await runStep(press, step);
      } catch (error) {
        const code = error instanceof StepFailure ? error.code : failureOf(error);
        if (code === "error") console.error(`[buttons] step ${step.type} failed`, redactError(error));
        return { ok: false, done: index, step: index, type: step.type, code };
      }
    }
    return { ok: true, done: config.steps.length, open };
  });
}

/** What a write's error means for the clicker. */
function failureOf(error: unknown): ButtonStepFailure {
  if (error instanceof AccessError) return "noAccess";
  if (error instanceof PropertyValueError) return "invalidValue";
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "pageLocked") return "locked";
  if (code === "pageInTrash") return "noAccess";
  return "error";
}

function runStep(press: Press, step: Exclude<ButtonStep, { type: "open" }>) {
  switch (step.type) {
    case "insert":
      return insertBlocks(press, step);
    case "add_row":
      return addRow(press, step);
    case "update_rows":
      return updateRows(press, step);
    case "notify":
      return notify(press, step);
    case "webhook":
      return webhook(press, step);
  }
}

/** A web address or a page of the workspace, as the browser opens it. */
function openTarget(step: Extract<ButtonStep, { type: "open" }>) {
  const link = parseImageLink(step.target, env.appUrl);
  if (!link) throw new StepFailure("invalidTarget", "Open needs a web address or a page");
  return { href: link.href, page: link.kind === "page" };
}

async function insertBlocks(press: Press, step: Extract<ButtonStep, { type: "insert" }>) {
  const markdown = resolveText(step.markdown, press.scope).value;
  if (!markdown.trim()) throw new StepFailure("notConfigured", "Nothing to insert");
  await requirePageAccess(press.userId, press.pageId, "edit");
  const edit = step.at === "below" ? { op: "insert_after" as const, blockId: press.blockId } : { op: step.at === "top" ? ("prepend" as const) : ("append" as const) };
  const written = await getCollab().editBlocks(press.pageId, [{ ...edit, markdown }], { userId: press.userId });
  if (written.missing) throw new StepFailure("buttonGone", "The button isn't on the page any more");
}

/** The database a step writes to, if the clicker may add and change its rows. */
async function writableDatabase(press: Press, databaseId: string) {
  if (!databaseId) throw new StepFailure("notConfigured", "No database chosen");
  let database;
  try {
    database = await requireDatabase(press.userId, databaseId, "edit");
  } catch {
    throw new StepFailure("noAccess", "You can't add or change rows in that database");
  }
  if (database.workspaceId !== press.workspaceId || database.archivedAt) throw new StepFailure("databaseGone", "The database is gone or in the trash");
  return database;
}

/** A step's values as a row write takes them, by property id (properties deleted since are left out). */
async function rowValues(press: Press, databaseId: string, values: StepValues) {
  const props = await getProperties(databaseId);
  const patch: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(values)) {
    const prop = props.find((p) => p.id === id);
    if (!prop) continue;
    if (isDynamicValue(value)) patch[id] = value.$ === "now" ? press.scope.today : [press.userId];
    else patch[id] = coerceValue(prop, resolveValue(value, press.scope).value);
  }
  return patch;
}

async function addRow(press: Press, step: Extract<ButtonStep, { type: "add_row" }>) {
  await writableDatabase(press, step.databaseId);
  const properties = await rowValues(press, step.databaseId, step.values);
  const title = resolveText(step.title, press.scope).value.trim();
  if (!step.template) {
    await createRows(press.userId, step.databaseId, [{ title, properties }]);
    return;
  }
  // From a row template: the step's values go over the template's, its "today" is the clicker's.
  const template = await rowTemplateInput(step.databaseId, step.template);
  if (!template) throw new StepFailure("templateGone", "The row template is gone");
  await createRow({ userId: press.userId }, step.databaseId, { title, properties, ...template, timeZone: press.timeZone });
}

async function updateRows(press: Press, step: Extract<ButtonStep, { type: "update_rows" }>) {
  await writableDatabase(press, step.databaseId);
  const patch = await rowValues(press, step.databaseId, step.values);
  if (!Object.keys(patch).length) throw new StepFailure("notConfigured", "No values to set");
  // The rows the clicker sees that the filters match, as a view of the database with them shows.
  const rows = (
    await viewedRows(press.userId, step.databaseId, { filters: step.filters, filterCombinator: step.filterCombinator }, undefined, { timeZone: press.timeZone })
  ).slice(0, MAX_BUTTON_ROWS);
  for (const row of rows) await updateRowProperties(press.userId, row.id, patch);
}

/** Tells these people about the page, those who can open it (agents have no inbox). */
async function notify(press: Press, step: Extract<ButtonStep, { type: "notify" }>) {
  if (!step.userIds.length) throw new StepFailure("notConfigured", "Nobody to notify");
  const message = resolveText(step.message, press.scope).value.trim().slice(0, 2000) || null;
  const people = (await db.select({ id: user.id }).from(user).where(and(inArray(user.id, step.userIds), notAgentUser(user.id)))).map((u) => u.id);
  const levels = await Promise.all(people.map(async (id) => ({ id, level: (await resolvePageAccess(id, press.pageId).catch(() => ({ level: "none" as const }))).level })));
  const recipients = levels.filter((r) => r.level !== "none").map((r) => r.id);
  if (!recipients.length) return;
  // An automation's kind of notice with no automation: the inbox says a button sent it.
  const inserted = await db
    .insert(notification)
    .values(recipients.map((userId) => ({ userId, workspaceId: press.workspaceId, kind: "automation" as const, actorId: press.userId, pageId: press.pageId, message })))
    .returning({ id: notification.id });
  signalInbox(press.workspaceId);
  pushNotifications(inserted.map((n) => n.id));
}

/** The secret a button's webhooks are signed with: one per button, derived like an automation's. */
const buttonSecret = (pageId: string, blockId: string) => webhookSecret(`button:${pageId}:${blockId}`);

async function webhook(press: Press, step: Extract<ButtonStep, { type: "webhook" }>) {
  if (!step.url.trim()) throw new StepFailure("notConfigured", "No webhook address");
  // Sending the page out is an export of it.
  if (!(await exportAllowed(press.workspaceId))) throw new StepFailure("exportOff", "This workspace doesn't let content leave it");
  const [{ title, markdown }, [actor]] = await Promise.all([
    getCollab().readPage(press.pageId),
    db.select({ id: user.id, name: user.name }).from(user).where(eq(user.id, press.userId)),
  ]);
  const id = crypto.randomUUID();
  const event = "button.clicked";
  const url = `${env.appUrl}/w/${press.workspaceId}/p/${press.pageId}`;
  const body = JSON.stringify({
    id,
    event,
    created_at: new Date().toISOString(),
    workspace_id: press.workspaceId,
    button: { id: press.blockId, label: press.label },
    page: { id: press.pageId, title: pageLabel(title), url, markdown },
    actor: actor ? { id: actor.id, name: actor.name } : null,
  });
  try {
    await sendWebhook(step.url, { id, event, body, secret: buttonSecret(press.pageId, press.blockId) });
  } catch (error) {
    if (error instanceof WebhookError) throw new StepFailure("webhookFailed", error.message);
    throw error;
  }
}

/**
 * What a button's settings need, for people who may edit the page (they set it up): the signing
 * secret of its webhooks (a button just added may not be saved yet: the secret is its id's) and the
 * workspace's people a notice can go to (none for guests, who can't list them).
 */
export async function buttonSettings(userId: string, pageId: string, blockId: string) {
  const page = await requirePageAccess(userId, pageId, "edit");
  const members = await listMembers(userId, page.workspaceId).catch((error) => {
    if (error instanceof AccessError) return [];
    throw error;
  });
  return {
    secret: buttonSecret(pageId, blockId),
    people: members.map((m) => ({ id: m.userId, name: m.name, email: m.email, image: avatarSrc(m.image) })),
  };
}
