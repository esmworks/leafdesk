"use server";

import { getTranslations } from "next-intl/server";
import { readDashboardEmailTarget, type DashboardEmailTarget } from "@/lib/dashboard-emails";
import { pageAccessOf } from "@/server/access";
import * as emails from "@/server/dashboard-emails";
import { mailStatus } from "@/server/mail";
import { requireUserId } from "@/server/session";

/**
 * Dashboard emails (server/dashboard-emails): subscriptions to a dashboard block or a dashboard
 * view, set from the dashboard and listed in Settings. The target and input come from the browser
 * and are checked there.
 */

export type DashboardEmailResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function run<T>(label: string, fn: (userId: string) => Promise<T>): Promise<DashboardEmailResult<T>> {
  const userId = await requireUserId();
  try {
    return { ok: true, data: await fn(userId) };
  } catch (error) {
    const t = await getTranslations("page.dashboard.emails.errors");
    if (error instanceof emails.DashboardEmailError) return { ok: false, error: t(error.code) };
    console.error(`[${label}]`, error);
    return { ok: false, error: t("generic") };
  }
}

function targetOf(value: unknown): DashboardEmailTarget {
  const target = readDashboardEmailTarget(value);
  if (!target) throw new emails.DashboardEmailError("notFound");
  return target;
}

const pageIdOf = (value: unknown) => {
  if (typeof value !== "string" || !value) throw new emails.DashboardEmailError("notFound");
  return value;
};

export type DashboardEmailsData = {
  /** Whether the server can send email at all. */
  mailEnabled: boolean;
  /** Whether the viewer may email people other than themselves (edit access to the page). */
  canEmailOthers: boolean;
  subscriptions: emails.DashboardEmailView[];
  /** Whom the viewer may name as recipients (themselves first). */
  people: { id: string; name: string; email: string; image: string | null }[];
  viewerId: string;
};

export async function listDashboardEmailsAction(pageId: string, target: unknown) {
  return run("list dashboard emails", async (userId): Promise<DashboardEmailsData> => {
    const id = pageIdOf(pageId);
    const subscriptions = await emails.listDashboardEmails(userId, id, targetOf(target));
    const [{ level }, people] = await Promise.all([pageAccessOf(userId, id), emails.dashboardEmailPeople(userId, id)]);
    people.sort((a, b) => (a.id === userId ? -1 : b.id === userId ? 1 : a.name.localeCompare(b.name)));
    return { mailEnabled: mailStatus() !== "disabled", canEmailOthers: level === "edit" || level === "full", subscriptions, people, viewerId: userId };
  });
}

export async function setDashboardEmailAction(pageId: string, target: unknown, input: emails.DashboardEmailInput, id: string | null) {
  return run("set dashboard email", (userId) =>
    emails.setDashboardEmail(userId, pageIdOf(pageId), targetOf(target), input ?? {}, typeof id === "string" && id ? id : null),
  );
}

export async function removeDashboardEmailAction(id: string) {
  return run("remove dashboard email", (userId) => emails.removeDashboardEmail(userId, pageIdOf(id)));
}

export async function leaveDashboardEmailAction(id: string) {
  return run("leave dashboard email", async (userId) => {
    await emails.leaveDashboardEmail(userId, pageIdOf(id));
  });
}

export async function sendTestDashboardEmailAction(pageId: string, target: unknown, input: Omit<emails.DashboardEmailInput, "recipients">) {
  return run("send test dashboard email", (userId) => emails.sendTestDashboardEmail(userId, pageIdOf(pageId), targetOf(target), input ?? {}));
}

export async function myDashboardEmailsAction() {
  return run("my dashboard emails", (userId) => emails.myDashboardEmails(userId));
}
