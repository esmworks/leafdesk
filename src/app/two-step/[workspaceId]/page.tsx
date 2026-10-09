import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getAccountSecurity } from "@/server/account-security";
import { findMembership, policyHoldFor } from "@/server/access";
import { listWorkspaces } from "@/server/pages";
import { blockedByWorkspacePolicy, policyGatePath, requireSession } from "@/server/session";
import { TwoStepGate } from "./two-step-gate";
import { Logo } from "@/components/brand/logo";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("security.gate");
  return { title: t("metaTitle") };
}

/**
 * Where a workspace that requires two-step verification sends people whose session doesn't pass
 * it: set up an authenticator app, or use (or add) a passkey, then continue into the workspace.
 */
export default async function TwoStepPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const session = await requireSession();
  const { workspaceId } = await params;
  if (!(await findMembership(session.user.id, workspaceId))) notFound();
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold !== "two-factor") redirect(hold ? policyGatePath(workspaceId, hold) : `/w/${workspaceId}`);
  const [workspaces, security, afterPasskey, t] = await Promise.all([
    listWorkspaces(session.user.id),
    getAccountSecurity(session.user.id),
    // A passkey sign-in is a new session that didn't come through single sign-on: in a workspace
    // that also requires it, that would only trade this page for the single sign-on one.
    policyHoldFor(session.user.id, workspaceId, { strong: true, ssoProviderId: null }),
    getTranslations("security.gate"),
  ]);
  const current = workspaces.find((w) => w.id === workspaceId);
  const others = workspaces.filter((w) => w.id !== workspaceId);

  return (
    <main className="flex min-h-full items-center justify-center bg-bg-subtle px-4 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo className="h-8 w-auto" />
        </div>
        <div className="rounded-xl border border-border bg-bg p-6 shadow-sm">
          <TwoStepGate
            workspaceId={workspaceId}
            workspaceName={current?.name ?? ""}
            hasPassword={security.hasPassword}
            hasPasskeys={security.passkeys.length > 0}
            passkeyAllowed={afterPasskey === null}
            email={session.user.email}
          />
        </div>
        {others.length > 0 && (
          <nav aria-label={t("otherWorkspaces")} className="mt-6 space-y-2 text-center text-sm text-fg-muted">
            <p>{t("otherWorkspaces")}</p>
            <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
              {others.map((w) => (
                <li key={w.id}>
                  <Link href={`/w/${w.id}`} className="text-accent hover:underline">
                    {w.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </main>
  );
}
