import { createTranslator } from "next-intl";
import type { Locale } from "@/i18n/config";
import type { WorkspaceRole } from "@/db/schema";
import { emailMessages } from "@/i18n/messages/email";
import { env } from "@/lib/env";
import { formatIsoDate } from "@/lib/mentions";

export type EmailContent = {
  subject: string;
  heading: string;
  paragraphs: string[];
  /** Main call to action, rendered as a button with the plain link below it. */
  action?: { label: string; url: string };
};

export type RenderedEmail = { subject: string; text: string; html: string };

export function emailTranslator(locale: Locale) {
  return createTranslator({ locale, messages: emailMessages[locale] });
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(url: string) {
  const { protocol } = new URL(url);
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`Refusing to put a ${protocol} link in an email`);
  return url;
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Plain-text and HTML versions of one email, in the shared layout. */
export function renderEmail(locale: Locale, content: EmailContent): RenderedEmail {
  const t = emailTranslator(locale);
  const footer = t("footer", { appUrl: env.appUrl });
  const action = content.action && { label: content.action.label, url: safeUrl(content.action.url) };

  const text = [
    content.heading,
    ...content.paragraphs,
    ...(action ? [`${action.label}: ${action.url}`] : []),
    `--\n${footer}`,
  ].join("\n\n");

  const paragraphs = content.paragraphs
    .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p)}</p>`)
    .join("\n");
  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
<tr><td style="border-radius:6px;background:#2f7d4f;">
<a href="${escapeHtml(action.url)}" style="display:inline-block;padding:10px 18px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(action.label)}</a>
</td></tr>
</table>
<p style="margin:0;font-size:13px;color:#6b6d75;">${escapeHtml(t("actionFallback"))}<br>
<a href="${escapeHtml(action.url)}" style="color:#2f7d4f;word-break:break-all;">${escapeHtml(action.url)}</a></p>`
    : "";

  const html = `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(content.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">
<tr><td style="padding:32px;font-family:${FONT};font-size:15px;line-height:1.6;color:#1f2023;">
<p style="margin:0 0 24px;font-size:14px;font-weight:600;color:#6b6d75;">Leafdesk</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;">${escapeHtml(content.heading)}</h1>
${paragraphs}
${button}
</td></tr>
</table>
<p style="margin:16px 0 0;font-family:${FONT};font-size:12px;color:#9a9ca3;">${escapeHtml(footer)}</p>
</td></tr>
</table>
</body>
</html>`;

  return { subject: content.subject, text, html };
}

export function testEmail(locale: Locale): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("test.subject"),
    heading: t("test.heading"),
    paragraphs: [t("test.body", { appUrl: env.appUrl })],
  });
}

export function invitationEmail(
  locale: Locale,
  invitation: { inviterName: string; workspaceName: string; email: string; role: WorkspaceRole; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { inviter: invitation.inviterName, workspace: invitation.workspaceName };
  return renderEmail(locale, {
    subject: t("invitation.subject", names),
    heading: t("invitation.heading", names),
    paragraphs: [
      t("invitation.body", { ...names, role: t(`invitation.roles.${invitation.role}`) }),
      t("invitation.expires", { email: invitation.email }),
    ],
    action: { label: t("invitation.action"), url: invitation.link },
  });
}

export function assignmentEmail(
  locale: Locale,
  assignment: { actorName: string; rowTitle: string; databaseTitle: string; propertyName: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = {
    actor: assignment.actorName,
    row: assignment.rowTitle,
    database: assignment.databaseTitle,
    property: assignment.propertyName,
  };
  return renderEmail(locale, {
    subject: t("assignment.subject", names),
    heading: t("assignment.heading", names),
    paragraphs: [t("assignment.body", names), t("assignment.optOut")],
    action: { label: t("assignment.action"), url: assignment.link },
  });
}

export function shareEmail(
  locale: Locale,
  share: { actorName: string; pageTitle: string; workspaceName: string; level: "view" | "comment" | "edit" | "full"; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { actor: share.actorName, page: share.pageTitle, workspace: share.workspaceName };
  return renderEmail(locale, {
    subject: t("share.subject", names),
    heading: t("share.heading", names),
    paragraphs: [t("share.body", { ...names, level: t(`share.levels.${share.level}`) }), t("share.optOut")],
    action: { label: t("share.action"), url: share.link },
  });
}

/** Longest excerpt of a comment in its email. */
const COMMENT_EXCERPT = 500;

export function commentEmail(
  locale: Locale,
  comment: { actorName: string; pageTitle: string; workspaceName: string; text: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { actor: comment.actorName, page: comment.pageTitle, workspace: comment.workspaceName };
  const text = comment.text.length > COMMENT_EXCERPT ? `${comment.text.slice(0, COMMENT_EXCERPT).trimEnd()}…` : comment.text;
  return renderEmail(locale, {
    subject: t("comment.subject", names),
    heading: t("comment.heading", names),
    paragraphs: [t("comment.quote", { text }), t("comment.body", names), t("comment.optOut")],
    action: { label: t("comment.action"), url: comment.link },
  });
}

export function mentionEmail(
  locale: Locale,
  mention: { actorName: string; pageTitle: string; workspaceName: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { actor: mention.actorName || t("mention.someone"), page: mention.pageTitle, workspace: mention.workspaceName };
  return renderEmail(locale, {
    subject: t("mention.subject", names),
    heading: t("mention.heading", names),
    paragraphs: [t("mention.body", names), t("mention.optOut")],
    action: { label: t("mention.action"), url: mention.link },
  });
}

export function reminderEmail(
  locale: Locale,
  reminder: { date: string; pageTitle: string; workspaceName: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { date: formatIsoDate(reminder.date, locale, "long"), page: reminder.pageTitle, workspace: reminder.workspaceName };
  return renderEmail(locale, {
    subject: t("reminder.subject", names),
    heading: t("reminder.heading", names),
    paragraphs: [t("reminder.body", names), t("reminder.optOut")],
    action: { label: t("reminder.action"), url: reminder.link },
  });
}

/** To a row's people: the reminder of one of its date properties (see server/date-reminders). */
export function dateReminderEmail(
  locale: Locale,
  reminder: {
    date: string;
    pageTitle: string;
    databaseTitle: string;
    propertyName: string;
    workspaceName: string;
    link: string;
    /** Where a time is read (a date's time, not a day). */
    timeZone?: string;
  },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = {
    date: formatIsoDate(reminder.date, locale, "long", reminder.timeZone ?? "UTC"),
    page: reminder.pageTitle,
    database: reminder.databaseTitle,
    property: reminder.propertyName,
    workspace: reminder.workspaceName,
  };
  return renderEmail(locale, {
    subject: t("dateReminder.subject", names),
    heading: t("dateReminder.heading", names),
    paragraphs: [t("dateReminder.body", names), t("dateReminder.optOut", names)],
    action: { label: t("dateReminder.action"), url: reminder.link },
  });
}

/** To the people a database automation names: a row was added or changed. */
export function automationEmail(
  locale: Locale,
  automation: { automationName: string; actorName: string; pageTitle: string; databaseTitle: string; workspaceName: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = {
    automation: automation.automationName,
    actor: automation.actorName || t("automation.someone"),
    page: automation.pageTitle,
    database: automation.databaseTitle,
    workspace: automation.workspaceName,
  };
  return renderEmail(locale, {
    subject: t("automation.subject", names),
    heading: t("automation.heading", names),
    paragraphs: [t("automation.body", names), t("automation.optOut")],
    action: { label: t("automation.action"), url: automation.link },
  });
}

/** To the people with full access to a page: someone asked for access to it. */
export function accessRequestEmail(
  locale: Locale,
  request: { requesterName: string; requesterEmail: string; pageTitle: string; workspaceName: string; message: string | null; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = {
    requester: request.requesterName || request.requesterEmail,
    email: request.requesterEmail,
    page: request.pageTitle,
    workspace: request.workspaceName,
  };
  return renderEmail(locale, {
    subject: t("accessRequest.subject", names),
    heading: t("accessRequest.heading", names),
    paragraphs: [
      t("accessRequest.body", names),
      ...(request.message ? [t("accessRequest.message", { message: request.message })] : []),
      t("accessRequest.answer"),
      t("accessRequest.optOut"),
    ],
    action: { label: t("accessRequest.action"), url: request.link },
  });
}

/** To the requester: their request was approved, with the level they got. */
export function accessApprovedEmail(
  locale: Locale,
  approval: { actorName: string; pageTitle: string; workspaceName: string; level: "view" | "comment" | "edit" | "full"; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { actor: approval.actorName || t("mention.someone"), page: approval.pageTitle, workspace: approval.workspaceName };
  return renderEmail(locale, {
    subject: t("accessApproved.subject", names),
    heading: t("accessApproved.heading", names),
    paragraphs: [t("accessApproved.body", { ...names, level: t(`share.levels.${approval.level}`) })],
    action: { label: t("accessApproved.action"), url: approval.link },
  });
}

/**
 * To the requester: their request was declined. Names neither the page nor the workspace nor who
 * declined it, since they still can't see the page; the link tells them which one it was.
 */
export function accessDeclinedEmail(locale: Locale, decline: { link: string }): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("accessDeclined.subject"),
    heading: t("accessDeclined.heading"),
    paragraphs: [t("accessDeclined.body", { link: decline.link }), t("accessDeclined.hint")],
  });
}

/** To a workspace's owners: someone asks to join it, or a member asks to invite someone. */
export function joinRequestEmail(
  locale: Locale,
  request: { kind: "join" | "invite"; askerName: string; email: string; workspaceName: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { asker: request.askerName || request.email, email: request.email, workspace: request.workspaceName };
  const key = request.kind === "invite" ? "joinRequest.invite" : "joinRequest.join";
  return renderEmail(locale, {
    subject: t(`${key}.subject`, names),
    heading: t(`${key}.heading`, names),
    paragraphs: [t(`${key}.body`, names), t("joinRequest.optOut")],
    action: { label: t("joinRequest.action"), url: request.link },
  });
}

/**
 * To whoever asked, once an owner decided: they joined (or were turned down), or the person they
 * wanted to invite was invited (or not).
 */
export function joinRequestDecidedEmail(
  locale: Locale,
  decision: { kind: "join" | "invite"; approved: boolean; email: string; workspaceName: string; link: string },
): RenderedEmail {
  const t = emailTranslator(locale);
  const names = { email: decision.email, workspace: decision.workspaceName };
  const key = `joinDecision.${decision.kind}${decision.approved ? "Approved" : "Declined"}` as const;
  return renderEmail(locale, {
    subject: t(`${key}.subject`, names),
    heading: t(`${key}.heading`, names),
    paragraphs: [t(`${key}.body`, names)],
    action: decision.approved ? { label: t("joinDecision.action"), url: decision.link } : undefined,
  });
}

/** The link that proves an address belongs to its account (Better Auth's email verification). */
export function verificationEmail(locale: Locale, verification: { name: string; url: string }): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("verification.subject"),
    heading: t("verification.heading"),
    paragraphs: [t("verification.body", { name: verification.name }), t("verification.ignore")],
    action: { label: t("verification.action"), url: verification.url },
  });
}

/** Minutes a password reset link stays valid; also the Better Auth token lifetime. */
export const PASSWORD_RESET_MINUTES = 60;

export function passwordResetEmail(locale: Locale, reset: { name: string; url: string }): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("passwordReset.subject"),
    heading: t("passwordReset.heading"),
    paragraphs: [
      t("passwordReset.body", { name: reset.name }),
      t("passwordReset.expires", { minutes: PASSWORD_RESET_MINUTES }),
    ],
    action: { label: t("passwordReset.action"), url: reset.url },
  });
}

/**
 * Sent when someone signs in with the password an instance admin asked them to replace (see
 * server/required-password.ts): the same reset link as "Forgot password", with the reason.
 */
export function passwordResetRequiredEmail(locale: Locale, reset: { name: string; url: string }): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("passwordResetRequired.subject"),
    heading: t("passwordResetRequired.heading"),
    paragraphs: [
      t("passwordResetRequired.body", { name: reset.name }),
      t("passwordResetRequired.expires", { minutes: PASSWORD_RESET_MINUTES }),
    ],
    action: { label: t("passwordResetRequired.action"), url: reset.url },
  });
}

/** Sent to the new address: the link that makes it the account's email (see server/account.ts). */
export function emailChangeEmail(
  locale: Locale,
  change: { name: string; oldEmail: string; url: string; hours: number },
): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("emailChange.subject"),
    heading: t("emailChange.heading"),
    paragraphs: [
      t("emailChange.body", { name: change.name, old: change.oldEmail }),
      t("emailChange.expires", { hours: change.hours }),
    ],
    action: { label: t("emailChange.action"), url: change.url },
  });
}

/** Sent to the old address once the change went through, so a takeover doesn't go unnoticed. */
export function emailChangedEmail(locale: Locale, change: { name: string; oldEmail: string; newEmail: string }): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("emailChanged.subject"),
    heading: t("emailChanged.heading"),
    paragraphs: [
      t("emailChanged.body", { name: change.name, old: change.oldEmail, new: change.newEmail }),
      t("emailChanged.warning"),
    ],
  });
}

export function passwordChangedEmail(locale: Locale, change: { name: string }): RenderedEmail {
  const t = emailTranslator(locale);
  return renderEmail(locale, {
    subject: t("passwordChanged.subject"),
    heading: t("passwordChanged.heading"),
    paragraphs: [t("passwordChanged.body", { name: change.name }), t("passwordChanged.warning")],
  });
}
