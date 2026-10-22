import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { automationRun, databaseAutomation, page } from "@/db/schema";
import { INCOMING_PER_MINUTE, MAX_INCOMING_BYTES } from "@/lib/automations";
import { env } from "@/lib/env";
import { SlidingWindowLimiter } from "@/lib/rate-limit";
import { BodyTooLargeError, readBodyLimited } from "@/server/request-body";
import { kickAutomations, MAX_WAITING_RUNS } from "./queue";

/**
 * Incoming webhooks (trigger "incoming_webhook"): each such automation has a secret address,
 * `/api/automations/<id>/webhook/<token>`, the token derived from its `hook_salt` and the server's
 * secret (so it isn't stored, and a new salt replaces it). A JSON POST there queues a run without a
 * row whose `trigger` is the body. Anyone with the address can start the automation, so it is
 * shown only to those who manage it; at most INCOMING_PER_MINUTE requests a minute are taken, and
 * bodies of at most MAX_INCOMING_BYTES.
 */

export type IncomingResponse = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/** A fresh salt: a new automation's, or one that replaces its address. */
export const newHookSalt = () => randomBytes(18).toString("base64url");

/** The secret part of an automation's address. */
export const hookToken = (salt: string) => createHmac("sha256", env.authSecret).update(`automation-hook:${salt}`).digest("base64url");

export const hookUrl = (automationId: string, salt: string) => `${env.appUrl}/api/automations/${automationId}/webhook/${hookToken(salt)}`;

const g = globalThis as typeof globalThis & { __leafdeskIncomingRate?: SlidingWindowLimiter };
const limiter = (g.__leafdeskIncomingRate ??= new SlidingWindowLimiter(INCOMING_PER_MINUTE, 60_000));

function sameToken(given: string, expected: string) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Takes a request to an automation's address: checks it, and queues the run. */
export async function receiveHook(automationId: string, token: string, request: Request): Promise<IncomingResponse> {
  const unknown = { status: 404, body: { error: "Unknown webhook address" } };
  const [found] = await db
    .select({ automation: databaseAutomation, archivedAt: page.archivedAt })
    .from(databaseAutomation)
    .innerJoin(page, eq(page.id, databaseAutomation.databaseId))
    .where(eq(databaseAutomation.id, automationId))
    .limit(1);
  // A wrong token looks like no automation at all.
  if (!found?.automation.hookSalt || !sameToken(token, hookToken(found.automation.hookSalt))) return unknown;
  const automation = found.automation;
  if (automation.trigger.type !== "incoming_webhook" || !automation.enabled || automation.version < 1 || found.archivedAt) {
    return { status: 409, body: { error: "The automation is off" } };
  }
  const wait = limiter.retryAfter(automation.id);
  if (wait > 0) {
    return { status: 429, body: { error: "Too many requests; slow down" }, headers: { "Retry-After": String(Math.ceil(wait / 1000)) } };
  }
  limiter.hit(automation.id);
  let text: string;
  try {
    text = new TextDecoder().decode(await readBodyLimited(request, MAX_INCOMING_BYTES));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return { status: 413, body: { error: `The body is larger than ${MAX_INCOMING_BYTES} bytes` } };
    throw error;
  }
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return { status: 400, body: { error: "The body is not JSON" } };
    }
  }
  const [{ waiting }] = await db
    .select({ waiting: count() })
    .from(automationRun)
    .where(and(eq(automationRun.automationId, automation.id), inArray(automationRun.status, ["pending", "running"])));
  if (waiting >= MAX_WAITING_RUNS) return { status: 429, body: { error: "Too many runs are waiting" } };
  const [run] = await db
    .insert(automationRun)
    .values({ automationId: automation.id, rowId: null, origin: "incoming_webhook", version: automation.version, triggerData: { body } })
    .returning({ id: automationRun.id });
  kickAutomations();
  return { status: 202, body: { ok: true, run_id: run.id } };
}
