import nodemailer, { type Transporter } from "nodemailer";
import { type MailConfig, MailConfigError, readMailConfig } from "./config";

export { MailConfigError } from "./config";
export {
  accessApprovedEmail,
  accessDeclinedEmail,
  accessRequestEmail,
  assignmentEmail,
  automationEmail,
  commentEmail,
  emailChangeEmail,
  emailChangedEmail,
  mentionEmail,
  passwordChangedEmail,
  reminderEmail,
  type EmailContent,
  type RenderedEmail,
  invitationEmail,
  joinRequestDecidedEmail,
  joinRequestEmail,
  verificationEmail,
  PASSWORD_RESET_MINUTES,
  passwordResetEmail,
  passwordResetRequiredEmail,
  renderEmail,
  shareEmail,
  testEmail,
} from "./templates";

/**
 * - `smtp`: mail is sent through the configured server.
 * - `console`: SMTP is not configured and this is development, so mail is printed to the log.
 * - `disabled`: SMTP is not configured (or misconfigured) in production. Features that need
 *   email should tell the user instead of offering the action.
 */
export type MailStatus = "smtp" | "console" | "disabled";

export class MailNotConfiguredError extends Error {
  readonly code = "mailNotConfigured";
  constructor() {
    super("Email is not configured on this server. Set SMTP_URL or SMTP_HOST, and MAIL_FROM.");
    this.name = "MailNotConfiguredError";
  }
}

export type OutgoingMail = { to: string; subject: string; text: string; html: string };

type Setup = { config: MailConfig | null; error: MailConfigError | null };

let setup: Setup | undefined;
let transporter: Transporter | undefined;

function getSetup(): Setup {
  if (!setup) {
    try {
      setup = { config: readMailConfig(), error: null };
    } catch (error) {
      if (!(error instanceof MailConfigError)) throw error;
      setup = { config: null, error };
    }
  }
  return setup;
}

export function mailStatus(): MailStatus {
  const { config, error } = getSetup();
  if (config) return "smtp";
  if (!error && process.env.NODE_ENV !== "production") return "console";
  return "disabled";
}

/** One line for the startup log. */
export function describeMailSetup(): string {
  const { config, error } = getSetup();
  if (error) return `mail: invalid SMTP settings, email is disabled (${error.message})`;
  if (config) return `mail: sending through ${config.description} as ${config.from}`;
  return mailStatus() === "console"
    ? "mail: SMTP is not configured, emails are printed to this log"
    : "mail: SMTP is not configured, features that send email are unavailable";
}

export async function sendMail(mail: OutgoingMail): Promise<void> {
  const { config, error } = getSetup();
  if (error) throw error;
  if (!config) {
    if (mailStatus() === "disabled") throw new MailNotConfiguredError();
    console.info(
      `[mail] SMTP is not configured; printing instead of sending.\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`,
    );
    return;
  }
  transporter ??= nodemailer.createTransport(config.transport, { from: config.from });
  await transporter.sendMail(mail);
}
