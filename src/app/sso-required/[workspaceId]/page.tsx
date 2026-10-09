import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { findMembership } from "@/server/access";
import { listWorkspaces } from "@/server/pages";
import { blockedByWorkspacePolicy, policyGatePath, requireSession } from "@/server/session";
import { workspaceSignInProvider } from "@/server/sso";
import { SsoGate } from "./sso-gate";
import { Logo } from "@/components/brand/logo";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("security.ssoGate");
  return { title: t("metaTitle") };
}

/**
 * Where a workspace whose members must sign in with single sign-on sends a member whose session
 * came some other way: continue with the workspace's identity provider (its own connection, or the
 * instance's), which signs them in again. Owners and guests never land here (see policyHold).
 */
export default async function SsoRequiredPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const session = await requireSession();
  const { workspaceId } = await params;
  if (!(await findMembership(session.user.id, workspaceId))) notFound();
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold !== "sso") redirect(hold ? policyGatePath(workspaceId, hold) : `/w/${workspaceId}`);
  const [provider, workspaces, t] = await Promise.all([
    workspaceSignInProvider(workspaceId),
    listWorkspaces(session.user.id),
    getTranslations("security.ssoGate"),
  ]);
  if (!provider) redirect(`/w/${workspaceId}`);
  const current = workspaces.find((w) => w.id === workspaceId);
  const others = workspaces.filter((w) => w.id !== workspaceId);

  return (
    <main className="flex min-h-full items-center justify-center bg-bg-subtle px-4 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo className="h-8 w-auto" />
        </div>
        <div className="rounded-xl border border-border bg-bg p-6 shadow-sm">
          <SsoGate
            workspaceId={workspaceId}
            workspaceName={current?.name ?? ""}
            providerId={provider.providerId}
            providerName={provider.name}
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
