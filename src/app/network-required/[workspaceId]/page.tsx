import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/brand/logo";
import { formatIpAddress } from "@/lib/ip-allowlist";
import { findMembership } from "@/server/access";
import { listWorkspaces } from "@/server/pages";
import { blockedByWorkspacePolicy, policyGatePath, requestIp, requireSession } from "@/server/session";
import { NetworkGate } from "./network-gate";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("security.networkGate");
  return { title: t("metaTitle") };
}

/**
 * Where a workspace with approved networks sends people whose request comes from elsewhere (or from
 * an address the server couldn't tell): there is nothing to set up here, so the page says why, shows
 * the address the server sees, and offers to try again from another network. Their other
 * workspaces keep working.
 */
export default async function NetworkRequiredPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const session = await requireSession();
  const { workspaceId } = await params;
  if (!(await findMembership(session.user.id, workspaceId))) notFound();
  const hold = await blockedByWorkspacePolicy(session, workspaceId);
  if (hold !== "ip") redirect(hold ? policyGatePath(workspaceId, hold) : `/w/${workspaceId}`);
  const [workspaces, ip, t] = await Promise.all([listWorkspaces(session.user.id), requestIp(), getTranslations("security.networkGate")]);
  const current = workspaces.find((w) => w.id === workspaceId);
  const others = workspaces.filter((w) => w.id !== workspaceId);

  return (
    <main className="flex min-h-full items-center justify-center bg-bg-subtle px-4 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo className="h-8 w-auto" />
        </div>
        <div className="rounded-xl border border-border bg-bg p-6 shadow-sm">
          <NetworkGate
            workspaceId={workspaceId}
            workspaceName={current?.name ?? ""}
            address={formatIpAddress(ip)}
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
