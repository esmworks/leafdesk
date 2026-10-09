import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { listWorkspaces } from "@/server/pages";
import { getSession, policyGatePath } from "@/server/session";
import { getConsentClient, verifySignedAuthorizationQuery } from "@/server/mcp/consent";
import { connectingHeldBack } from "@/server/mcp/grants";
import { WRITE_SCOPE } from "@/server/mcp/principal";
import { ConsentForm } from "./consent-form";
import { scopeKey } from "./scopes";
import { Logo } from "@/components/brand/logo";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("consent");
  return { title: t("metaTitle") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function toQuery(params: Awaited<SearchParams>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  }
  return query;
}

function hostOf(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-bg-subtle px-4 py-16">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo className="h-8 w-auto" />
        </div>
        <div className="rounded-xl border border-border bg-bg p-6 shadow-sm">{children}</div>
      </div>
    </main>
  );
}

function Problem({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <h1 className="text-base font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-fg-muted">{body}</p>
    </Shell>
  );
}

export default async function ConsentPage({ searchParams }: { searchParams: SearchParams }) {
  const query = toQuery(await searchParams);
  const session = await getSession();
  // A session can expire between login and consent; signing in again resumes the flow.
  if (!session) redirect(`/sign-in?${query.toString()}`);
  // The app would reach every workspace; one whose sign-in policy this session doesn't meet comes first.
  const held = await connectingHeldBack(session);
  if (held) redirect(policyGatePath(held.workspaceId, held.hold));
  const t = await getTranslations("consent");
  const format = await getFormatter();
  const describe = (scope: string) => {
    const key = scopeKey(scope);
    return key ? t(`scopes.${key}`) : scope;
  };

  if (!(await verifySignedAuthorizationQuery(query))) {
    return (
      <Problem title={t("expired.title")} body={t("expired.body")} />
    );
  }

  const clientId = query.get("client_id") ?? "";
  const client = await getConsentClient(clientId);
  if (!client) {
    return (
      <Problem title={t("unknownClient.title")} body={t("unknownClient.body")} />
    );
  }

  const scopes = (query.get("scope") ?? "").split(" ").filter(Boolean);
  const workspaces = await listWorkspaces(session.user.id);
  const redirectHost = hostOf(query.get("redirect_uri"));
  const siteHost = hostOf(client.uri);

  return (
    <Shell>
      <div className="flex items-start gap-3">
        {client.icon ? (
          // Client logos are arbitrary remote URLs; next/image would need each host allow-listed.
          <img src={client.icon} alt="" className="h-10 w-10 shrink-0 rounded-md border border-border object-cover" />
        ) : (
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-bg-subtle text-base font-semibold text-fg-muted">
            {client.name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-base font-semibold">{t("heading", { client: client.name })}</h1>
          {client.uri && siteHost && (
            <a href={client.uri} target="_blank" rel="noreferrer" className="text-sm text-accent hover:underline">
              {siteHost}
            </a>
          )}
        </div>
      </div>

      <p className="mt-4 text-xs text-fg-muted">
        {client.metadataDocument
          ? t("identifiedBy", { host: hostOf(client.clientId) ?? client.clientId })
          : t("unverified")}
      </p>

      <ConsentForm
        clientName={client.name}
        user={{ name: session.user.name, email: session.user.email }}
        scopes={scopes
          .filter((s) => s !== WRITE_SCOPE)
          .map((s) => ({ scope: s, label: describe(s) }))}
        write={scopes.includes(WRITE_SCOPE) ? { scope: WRITE_SCOPE, label: describe(WRITE_SCOPE) } : null}
        workspaces={workspaces.length ? format.list(workspaces.map((w) => w.name), { type: "conjunction" }) : null}
        redirectHost={redirectHost}
      />
    </Shell>
  );
}
