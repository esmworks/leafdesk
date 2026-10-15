"use client";

import { Check, ExternalLink, Plug, Plus, RefreshCw, Search, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  beginConnectionOAuthAction,
  createConnectionAction,
  createTriggerAction,
  deleteConnectionAction,
  deleteTriggerAction,
  listConnectionEventsAction,
  listTriggersAction,
  refreshConnectionAction,
  revealEventSecretAction,
  setEventSecretAction,
  setToolKindAction,
  signOutConnectionAction,
  updateConnectionAction,
  updateTriggerAction,
} from "@/app/actions/connections";
import { TabButton } from "@/components/settings/members-panel";
import { SettingsHeader } from "@/components/settings/section";
import { CopyButton } from "@/components/settings/copy-button";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, Dialog, IconButton, Input, selectClass, Switch, textareaClass } from "@/components/ui";
import {
  CONNECTION_AUTH_TYPES,
  EVENT_PRESETS,
  MAX_CONNECTION_NAME,
  MAX_CONNECTIONS,
  MAX_TRIGGER_EVENT,
  type ConnectionAuthType,
  type ConnectionEventView,
  type ConnectionTriggerView,
  type ConnectionView,
  type EventPreset,
  type ToolKind,
} from "@/lib/connections";
import { MAX_AGENT_PROMPT } from "@/lib/agents";
import { CATALOG_CATEGORIES, catalogEntryFor, catalogLogo, searchCatalog, type CatalogCategory, type CatalogEntry } from "@/lib/connection-catalog";

export type ConnectionAgent = { id: string; name: string; icon: string | null };

type ConnectionTab = "tools" | "events" | "settings";

/**
 * What an owner needs to sign in as an OAuth app of their own: the redirect URL to give the app,
 * and the catalog services the instance already has an app for (CONNECTION_OAUTH_CLIENTS).
 */
export type OAuthSetup = { redirectUrl: string; instanceClients: readonly string[] };
const OAuthSetupContext = createContext<OAuthSetup>({ redirectUrl: "", instanceClients: [] });

/**
 * How the form asks for an OAuth app: `required` for a service that signs in only registered apps
 * (and the instance has none), `instance` when the instance's app is used, else `optional`.
 */
type ClientMode = "required" | "instance" | "optional";

function clientModeOf(authType: ConnectionAuthType, entry: CatalogEntry | null | undefined, setup: OAuthSetup): ClientMode | null {
  if (authType !== "oauth") return null;
  if (!entry?.client) return "optional";
  return setup.instanceClients.includes(entry.id) ? "instance" : "required";
}

/** A connection's emoji; else, for a service of the catalog, its logo; else a plug. */
export function ConnectionIcon({ icon, url, className }: { icon: string | null; url?: string; className?: string }) {
  if (icon) return <span className={cn("leading-none", className)}>{icon}</span>;
  const entry = url ? catalogEntryFor(url) : undefined;
  if (entry) return <ServiceLogo entry={entry} />;
  return <Plug className={cn("h-4 w-4 text-fg-muted", className)} aria-hidden />;
}

/**
 * A catalog service's logo, filling the box it sits in. It sits on white in either theme, since
 * most logos are drawn for a light background.
 */
function ServiceLogo({ entry }: { entry: CatalogEntry }) {
  return (
    <img
      src={catalogLogo(entry)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className="h-full w-full rounded-[22%] bg-white object-contain ring-1 ring-black/5"
    />
  );
}

/** Whether a tool runs at once (it only reads) or waits for an owner's approval. */
export function ToolKindLabel({ kind }: { kind: ToolKind }) {
  const t = useTranslations("settings.connections.tools");
  return <span className={cn("text-xs", kind === "write" ? "text-fg" : "text-fg-muted")}>{t(kind === "write" ? "writes" : "reads")}</span>;
}

/**
 * Settings > Connections, for owners: services the workspace's agents use (each a remote MCP
 * server). Owners add one and sign in to it, class its tools as reading or writing, give its event
 * address to the service and set which agent runs on which events. Which tools each agent may use
 * is set on the agent.
 */
export function ConnectionsPanel({ oauthSetup, ...props }: Parameters<typeof ConnectionList>[0] & { oauthSetup: OAuthSetup }) {
  return (
    <OAuthSetupContext.Provider value={oauthSetup}>
      <ConnectionList {...props} />
    </OAuthSetupContext.Provider>
  );
}

function ConnectionList({
  workspaceId,
  connections,
  agents,
  initialConnectionId,
  notice,
}: {
  workspaceId: string;
  connections: ConnectionView[];
  /** The workspace's active agents, for triggers. */
  agents: ConnectionAgent[];
  initialConnectionId?: string;
  /** How a sign-in the browser came back from went. */
  notice?: "signedIn" | "oauthFailed";
}) {
  const t = useTranslations("settings.connections");
  const [list, setList] = useState(connections);
  // A service of the catalog being added, or "custom" for a server of the owner's own.
  const [adding, setAdding] = useState<CatalogEntry | "custom" | null>(null);
  const [open, setOpen] = useState<{ id: string; tab: ConnectionTab } | null>(() =>
    initialConnectionId && connections.some((c) => c.id === initialConnectionId) ? { id: initialConnectionId, tab: "tools" } : null,
  );
  const [view, setView] = useState<"browse" | "connected">(initialConnectionId ? "connected" : "browse");
  const [shownNotice, setShownNotice] = useState(notice);

  useEffect(() => setList(connections), [connections]);
  // Shown once: reloading the page shouldn't say it again.
  useEffect(() => {
    if (notice || initialConnectionId) window.history.replaceState(null, "", `${window.location.pathname}?tab=connections`);
  }, [notice, initialConnectionId]);

  const replace = (view: ConnectionView) => setList((all) => (all.some((c) => c.id === view.id) ? all.map((c) => (c.id === view.id ? view : c)) : [...all, view]));
  const opened = open ? list.find((c) => c.id === open.id) : undefined;
  const full = list.length >= MAX_CONNECTIONS;

  return (
    <div>
      <SettingsHeader title={t("heading")} description={t("description")} />
      <div className="space-y-3">
        {shownNotice && (
          <p
            role="status"
            className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", shownNotice === "oauthFailed" ? "border-danger/40 text-danger" : "border-border text-fg-muted")}
          >
            <span className="flex-1">{t(`notices.${shownNotice}`)}</span>
            <button type="button" className="text-fg-faint hover:text-fg" aria-label={t("dismiss")} onClick={() => setShownNotice(undefined)}>
              <X className="h-3.5 w-3.5" />
            </button>
          </p>
        )}
        <div role="tablist" aria-label={t("heading")} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
          <TabButton active={view === "browse"} onClick={() => setView("browse")}>
            {t("tabs.browse")}
          </TabButton>
          <TabButton active={view === "connected"} onClick={() => setView("connected")}>
            {t("tabs.connected")} <span className="text-fg-faint">{list.length}</span>
          </TabButton>
        </div>
        {view === "browse" ? (
          <CatalogBrowser
            existing={list}
            full={full}
            onPick={setAdding}
            onOpen={(conn) => setOpen({ id: conn.id, tab: "tools" })}
          />
        ) : (
          <>
            <p className="text-xs text-fg-muted">{t("approvalNote")}</p>
            <div className="overflow-hidden rounded-xl border border-border">
              {list.length ? (
                <ul className="divide-y divide-border">
                  {list.map((conn) => (
                    <li key={conn.id}>
                      <button type="button" onClick={() => setOpen({ id: conn.id, tab: "tools" })} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-bg-hover">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-lg">
                          <ConnectionIcon icon={conn.icon} url={conn.url} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{conn.name}</span>
                          <span className="block truncate text-xs text-fg-muted">{hostOf(conn.url)}</span>
                        </span>
                        <StatusText conn={conn} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="space-y-3 px-4 py-8 text-center">
                  <p className="text-sm text-fg-muted">{t("empty")}</p>
                  <Button variant="secondary" onClick={() => setView("browse")}>
                    {t("browse")}
                  </Button>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {adding && (
        <Dialog open onClose={() => setAdding(null)} className="max-w-lg">
          <AddConnectionForm
            workspaceId={workspaceId}
            entry={adding === "custom" ? null : adding}
            onClose={() => setAdding(null)}
            onAdded={(added) => {
              replace(added);
              setAdding(null);
              setView("connected");
              setOpen({ id: added.id, tab: "tools" });
            }}
          />
        </Dialog>
      )}
      {opened && open && (
        <ConnectionDialog
          workspaceId={workspaceId}
          conn={opened}
          agents={agents}
          tab={open.tab}
          onTab={(tab) => setOpen({ id: opened.id, tab })}
          onChange={replace}
          onDeleted={() => {
            setList((all) => all.filter((c) => c.id !== opened.id));
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function StatusText({ conn }: { conn: ConnectionView }) {
  const t = useTranslations("settings.connections.status");
  return (
    <span className={cn("shrink-0 text-xs", conn.status === "error" ? "text-danger" : conn.status === "needsAuth" ? "text-fg" : "text-fg-muted")}>
      {conn.status === "ready" ? t("ready", { n: conn.tools.length }) : t(conn.status)}
    </span>
  );
}

/** Sends the browser to the service to sign in (or, already signed in, just lists the tools again). */
function useSignIn(workspaceId: string, onChange: (view: ConnectionView) => void) {
  const { pending, error, run } = useAction();
  const signIn = (conn: ConnectionView) =>
    run(
      () => beginConnectionOAuthAction(workspaceId, conn.id),
      (started) => {
        if (started) window.location.assign(started.url);
        else void refreshConnectionAction(workspaceId, conn.id).then((res) => res.ok && onChange(res.data));
      },
    );
  return { pending, error, signIn };
}

/**
 * The catalog of services Leafdesk knows how to reach, as cards by category: picking one opens the
 * form filled in from it, and a service already added opens its connection.
 */
function CatalogBrowser({
  existing,
  full,
  onPick,
  onOpen,
}: {
  existing: ConnectionView[];
  /** At the most connections a workspace takes: nothing more can be added. */
  full: boolean;
  onPick: (entry: CatalogEntry | "custom") => void;
  onOpen: (conn: ConnectionView) => void;
}) {
  const t = useTranslations("settings.connections");
  const setup = useContext(OAuthSetupContext);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CatalogCategory | "">("");
  const categoryLabel = (c: CatalogCategory) => t(`catalog.categories.${c}`);
  const found = searchCatalog(query, categoryLabel).filter((entry) => !category || entry.category === category);
  const added = useMemo(() => {
    const byEntry = new Map<string, ConnectionView>();
    for (const conn of existing) {
      const id = catalogEntryFor(conn.url)?.id;
      if (id && !byEntry.has(id)) byEntry.set(id, conn);
    }
    return byEntry;
  }, [existing]);
  const groups = CATALOG_CATEGORIES.map((c) => ({ category: c, entries: found.filter((entry) => entry.category === c) })).filter((g) => g.entries.length);
  const tooMany = full ? t("errors.tooMany", { max: MAX_CONNECTIONS }) : undefined;

  return (
    <div className="space-y-4">
      <p className="text-sm text-fg-muted">{t("catalog.description")}</p>
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" aria-hidden />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("catalog.search")}
            aria-label={t("catalog.search")}
            className="pl-8"
          />
        </label>
        <select
          className={cn(selectClass, "max-w-full")}
          value={category}
          aria-label={t("catalog.allCategories")}
          onChange={(e) => setCategory(e.target.value as CatalogCategory | "")}
        >
          <option value="">{t("catalog.allCategories")}</option>
          {CATALOG_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
        <Button variant="secondary" disabled={full} title={tooMany} onClick={() => onPick("custom")}>
          <Plus className="h-3.5 w-3.5" />
          {t("catalog.custom")}
        </Button>
      </div>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-fg-muted">{t("catalog.none")}</p>
      ) : (
        groups.map((group) => (
          <section key={group.category}>
            <h3 className="mb-2 text-sm font-medium">
              {categoryLabel(group.category)} <span className="font-normal text-fg-faint">{group.entries.length}</span>
            </h3>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {group.entries.map((entry) => {
                const conn = added.get(entry.id);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      disabled={!conn && full}
                      title={conn ? undefined : tooMany}
                      onClick={() => (conn ? onOpen(conn) : onPick(entry))}
                      className="group flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="h-10 w-10 shrink-0">
                        <ServiceLogo entry={entry} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{entry.name}</span>
                        <span className="block truncate text-xs text-fg-muted">
                          {clientModeOf(entry.authType, entry, setup) === "required" ? t("catalog.ownApp") : t(`catalog.auth.${entry.authType}`)}
                        </span>
                      </span>
                      {conn ? (
                        <span className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
                          <Check className="h-3.5 w-3.5" aria-hidden />
                          {t("catalog.added")}
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-md border border-border bg-bg px-2 py-1 text-xs font-medium group-hover:border-fg-faint">
                          {t("catalog.connect")}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
      <p className="text-xs text-fg-muted">{t("catalog.count", { n: found.length })}</p>
    </div>
  );
}

function AddConnectionForm({
  workspaceId,
  entry,
  onClose,
  onAdded,
}: {
  workspaceId: string;
  /** The catalog's service the form starts from (null: an empty form). */
  entry: CatalogEntry | null;
  onClose: () => void;
  onAdded: (view: ConnectionView) => void;
}) {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const [name, setName] = useState(entry?.name ?? "");
  const [url, setUrl] = useState(entry?.url ?? "");
  const [authType, setAuthType] = useState<ConnectionAuthType>(entry?.authType ?? "oauth");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [eventPreset, setEventPreset] = useState<EventPreset>(entry?.eventPreset ?? "hmac");
  const { pending, error, run } = useAction();
  const sign = useSignIn(workspaceId, onAdded);
  const setup = useContext(OAuthSetupContext);
  // What comes from the service (the link to its keys, its app) only while the form still points at it.
  const atEntry = entry && url.trim() === entry.url ? entry : null;
  const tokenHelp = atEntry?.tokenHelp ? { href: atEntry.tokenHelp, name: atEntry.name } : undefined;
  const clientMode = clientModeOf(authType, atEntry, setup);
  const clientMissing = clientMode === "required" && (!clientId.trim() || (!atEntry?.client?.secretOptional && !clientSecret.trim()));

  return (
    <form
      className="space-y-4 px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            createConnectionAction(workspaceId, {
              name,
              url,
              authType,
              token: authType === "token" ? token : undefined,
              oauthClient: authType === "oauth" && clientId.trim() ? { clientId, clientSecret } : undefined,
              eventPreset,
            }),
          (view) => {
            // An OAuth connection goes straight on to signing in at the service.
            if (view.authType === "oauth") sign.signIn(view);
            else onAdded(view);
          },
        );
      }}
    >
      {entry ? (
        <div className="flex items-center gap-3">
          <span className="h-10 w-10 shrink-0">
            <ServiceLogo entry={entry} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{entry.name}</h2>
            <p className="truncate text-sm text-fg-muted">{t(`catalog.categories.${entry.category}`)}</p>
          </div>
        </div>
      ) : (
        <>
          <h2 className="text-base font-semibold">{t("addTitle")}</h2>
          <p className="text-sm text-fg-muted">{t("addDescription")}</p>
        </>
      )}
      <ConnectionFields
        name={name}
        url={url}
        authType={authType}
        token={token}
        eventPreset={eventPreset}
        onName={setName}
        onUrl={setUrl}
        onAuthType={setAuthType}
        onToken={setToken}
        onEventPreset={setEventPreset}
        tokenRequired
        tokenHelp={tokenHelp}
      >
        {clientMode && (
          <OAuthClientFields
            mode={clientMode}
            service={atEntry ?? undefined}
            clientId={clientId}
            clientSecret={clientSecret}
            onClientId={setClientId}
            onClientSecret={setClientSecret}
            secretKept={false}
          />
        )}
      </ConnectionFields>
      {(error || sign.error) && (
        <p role="alert" className="text-sm text-danger">
          {error || sign.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending || sign.pending || !name.trim() || !url.trim() || (authType === "token" && !token.trim()) || clientMissing}>
          {authType === "oauth" ? t("addAndSignIn") : t("addButton")}
        </Button>
      </div>
    </form>
  );
}

function ConnectionFields(props: {
  name: string;
  url: string;
  authType: ConnectionAuthType;
  token: string;
  eventPreset: EventPreset;
  onName: (v: string) => void;
  onUrl: (v: string) => void;
  onAuthType: (v: ConnectionAuthType) => void;
  onToken: (v: string) => void;
  onEventPreset: (v: EventPreset) => void;
  /** A new connection needs its token; a saved one keeps it when left empty. */
  tokenRequired: boolean;
  /** Where the service's tokens are made, for a service of the catalog. */
  tokenHelp?: { href: string; name: string };
  /** The OAuth app's fields, under how it signs in. */
  children?: ReactNode;
}) {
  const t = useTranslations("settings.connections.fields");
  return (
    <div className="space-y-3">
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("name")}</span>
        <Input value={props.name} maxLength={MAX_CONNECTION_NAME} onChange={(e) => props.onName(e.target.value)} placeholder={t("namePlaceholder")} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("url")}</span>
        <Input value={props.url} type="url" inputMode="url" onChange={(e) => props.onUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
        <span className="block text-xs text-fg-muted">{t("urlHelp")}</span>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("authType")}</span>
        <select className={cn(selectClass, "w-full")} value={props.authType} onChange={(e) => props.onAuthType(e.target.value as ConnectionAuthType)}>
          {CONNECTION_AUTH_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`authTypes.${type}`)}
            </option>
          ))}
        </select>
        <span className="block text-xs text-fg-muted">{t(`authHelp.${props.authType}`)}</span>
      </label>
      {props.children}
      {props.authType === "token" && (
        <div className="space-y-1">
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t("token")}</span>
            <Input
              value={props.token}
              type="password"
              autoComplete="off"
              onChange={(e) => props.onToken(e.target.value)}
              placeholder={props.tokenRequired ? undefined : t("tokenKeep")}
            />
          </label>
          {props.tokenHelp && (
            <a href={props.tokenHelp.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-muted underline hover:text-fg">
              {t("tokenHelp", { name: props.tokenHelp.name })}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
        </div>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("eventPreset")}</span>
        <select className={cn(selectClass, "w-full")} value={props.eventPreset} onChange={(e) => props.onEventPreset(e.target.value as EventPreset)}>
          {EVENT_PRESETS.map((preset) => (
            <option key={preset} value={preset}>
              {t(`presets.${preset}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The OAuth app a connection signs in as: asked for outright for a service that signs in only apps
 * registered with it, else folded away (any other server may want one too). Shows the redirect
 * URL the app must have.
 */
function OAuthClientFields(props: {
  mode: ClientMode;
  /** The catalog's service, for its name, where its apps are made and whether one may lack a secret. */
  service?: Pick<CatalogEntry, "name" | "client">;
  clientId: string;
  clientSecret: string;
  onClientId: (v: string) => void;
  onClientSecret: (v: string) => void;
  /** A saved secret stays when the field is left empty. */
  secretKept: boolean;
}) {
  const t = useTranslations("settings.connections.fields");
  const { redirectUrl } = useContext(OAuthSetupContext);
  const name = props.service?.name ?? "";
  const secretOptional = props.mode !== "required" || props.service?.client?.secretOptional;
  const fields = (
    <div className="space-y-3">
      <div className="space-y-1">
        <span className="text-sm font-medium">{t("redirectUrl")}</span>
        <div className="flex items-center gap-2">
          <Input readOnly value={redirectUrl} aria-label={t("redirectUrl")} className="min-w-0 flex-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={redirectUrl} />
        </div>
        <span className="block text-xs text-fg-muted">{t("redirectUrlHelp")}</span>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("clientId")}</span>
        <Input value={props.clientId} autoComplete="off" spellCheck={false} onChange={(e) => props.onClientId(e.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t("clientSecret")}</span>
        <Input
          value={props.clientSecret}
          type="password"
          autoComplete="off"
          onChange={(e) => props.onClientSecret(e.target.value)}
          placeholder={props.secretKept ? t("tokenKeep") : secretOptional ? t("clientSecretOptional") : undefined}
        />
      </label>
    </div>
  );
  if (props.mode === "required") {
    return (
      <div className="space-y-3 rounded-lg border border-border p-3">
        <div className="space-y-1">
          <p className="text-xs text-fg-muted">{t("clientRequired", { name })}</p>
          {props.service?.client && (
            <a href={props.service.client.help} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-fg-muted underline hover:text-fg">
              {t("clientHelp", { name })}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
        </div>
        {fields}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {props.mode === "instance" && <p className="text-xs text-fg-muted">{t("clientInstance", { name })}</p>}
      <Folded summary={t(props.mode === "instance" ? "clientOverride" : "clientOptional")} open={Boolean(props.clientId)}>
        {fields}
      </Folded>
    </div>
  );
}

/** Folded fields, open at first when they hold something (then the owner's to fold). */
function Folded({ summary, open, children }: { summary: string; open: boolean; children: ReactNode }) {
  const [initiallyOpen] = useState(open);
  return (
    <details open={initiallyOpen}>
      <summary className="cursor-pointer text-sm text-fg-muted hover:text-fg">{summary}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

/** One connection: its tools, its events and triggers, and its settings, in tabs. */
function ConnectionDialog({
  workspaceId,
  conn,
  agents,
  tab,
  onTab,
  onChange,
  onDeleted,
  onClose,
}: {
  workspaceId: string;
  conn: ConnectionView;
  agents: ConnectionAgent[];
  tab: ConnectionTab;
  onTab: (tab: ConnectionTab) => void;
  onChange: (view: ConnectionView) => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-lg">
          <ConnectionIcon icon={conn.icon} url={conn.url} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{conn.name}</h2>
          <p className="truncate text-sm text-fg-muted">{conn.url}</p>
        </div>
        <IconButton label={tc("close")} onClick={onClose} className="h-7 w-7">
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="border-b border-border px-5 py-2">
        <div role="tablist" aria-label={conn.name} className="inline-flex gap-0.5 rounded-lg bg-bg-hover p-0.5">
          {(["tools", "events", "settings"] as const).map((name) => (
            <TabButton key={name} active={tab === name} onClick={() => onTab(name)}>
              {t(`tabs.${name}`)}
            </TabButton>
          ))}
        </div>
      </div>
      <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
        {tab === "tools" ? (
          <ToolsTab workspaceId={workspaceId} conn={conn} onChange={onChange} />
        ) : tab === "events" ? (
          <EventsTab workspaceId={workspaceId} conn={conn} agents={agents} />
        ) : (
          <SettingsTab workspaceId={workspaceId} conn={conn} onChange={onChange} onDeleted={onDeleted} />
        )}
      </div>
    </Dialog>
  );
}

function ToolsTab({ workspaceId, conn, onChange }: { workspaceId: string; conn: ConnectionView; onChange: (view: ConnectionView) => void }) {
  const t = useTranslations("settings.connections");
  const format = useFormatter();
  const { pending, error, run } = useAction();
  const sign = useSignIn(workspaceId, onChange);
  const signedInByOAuth = conn.authType === "oauth" && conn.status !== "needsAuth";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm">
          <StatusText conn={conn} />
          {conn.toolsAt && conn.status === "ready" && (
            <span className="text-xs text-fg-faint"> · {t("checkedAt", { time: format.dateTime(new Date(conn.toolsAt), { dateStyle: "medium", timeStyle: "short" }) })}</span>
          )}
        </p>
        {conn.authType === "oauth" && conn.status !== "ready" && (
          <Button size="sm" variant="primary" disabled={sign.pending} onClick={() => sign.signIn(conn)}>
            {t("signIn")}
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => refreshConnectionAction(workspaceId, conn.id), onChange)}>
          <RefreshCw className={cn("h-3.5 w-3.5", pending && "animate-spin")} />
          {t("refresh")}
        </Button>
        {signedInByOAuth && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => signOutConnectionAction(workspaceId, conn.id), onChange)}>
            {t("signOut")}
          </Button>
        )}
      </div>
      {conn.statusError && conn.status !== "ready" && <p className="text-xs break-words text-danger">{t(`statusErrors.${errorCodeOf(conn.statusError)}`)}</p>}
      {(error || sign.error) && (
        <p role="alert" className="text-sm text-danger">
          {error || sign.error}
        </p>
      )}
      <p className="text-xs text-fg-muted">{t("tools.description")}</p>
      {conn.tools.length === 0 ? (
        <p className="text-sm text-fg-muted">{conn.status === "ready" ? t("tools.none") : t("tools.notListed")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {conn.tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{tool.title || tool.name}</p>
                {tool.title && <p className="truncate text-xs text-fg-faint">{tool.name}</p>}
                {tool.description && <p className="line-clamp-2 text-xs text-fg-muted">{tool.description}</p>}
                {tool.kind !== tool.hinted && <p className="text-xs text-fg-faint">{t("tools.overridden")}</p>}
              </div>
              <select
                aria-label={t("tools.kindLabel", { tool: tool.title || tool.name })}
                className={cn(selectClass, "shrink-0")}
                value={tool.kind}
                disabled={pending}
                onChange={(e) => run(() => setToolKindAction(workspaceId, conn.id, tool.name, e.target.value as ToolKind), onChange)}
              >
                <option value="read">{t("tools.reads")}</option>
                <option value="write">{t("tools.writes")}</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The code at the head of a saved status error ("unauthorized: …"), for its translated text. */
const STATUS_ERRORS = ["unauthorized", "unreachable", "notMcp", "timeout", "oauth"] as const;
function errorCodeOf(statusError: string): (typeof STATUS_ERRORS)[number] | "other" {
  const code = statusError.split(":")[0];
  return STATUS_ERRORS.find((known) => known === code) ?? "other";
}

function EventsTab({ workspaceId, conn, agents }: { workspaceId: string; conn: ConnectionView; agents: ConnectionAgent[] }) {
  const t = useTranslations("settings.connections.events");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [secret, setSecret] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [triggers, setTriggers] = useState<ConnectionTriggerView[] | null>(null);
  const [events, setEvents] = useState<ConnectionEventView[] | null>(null);
  const [version, setVersion] = useState(0);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    void Promise.all([listTriggersAction(workspaceId, conn.id), listConnectionEventsAction(workspaceId, conn.id)]).then(([tr, ev]) => {
      if (!live) return;
      if (tr.ok) setTriggers(tr.data);
      if (ev.ok) setEvents(ev.data);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, conn.id, version]);

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? t("archivedAgent");

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("address")}</h3>
        <p className="text-xs text-fg-muted">{t(`addressHelp.${conn.eventPreset}`)}</p>
        <div className="flex items-center gap-2">
          <Input readOnly value={conn.eventUrl} className="min-w-0 flex-1 text-xs" onFocus={(e) => e.currentTarget.select()} />
          <CopyButton value={conn.eventUrl} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{t("secret")}</span>
          {secret ? (
            <>
              <code className="min-w-0 flex-1 truncate rounded bg-bg-hover px-1.5 py-0.5 text-xs">{secret}</code>
              <CopyButton value={secret} />
            </>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => revealEventSecretAction(workspaceId, conn.id), setSecret)}>
              {t("show")}
            </Button>
          )}
          {conn.eventPreset !== "slack" && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => setEventSecretAction(workspaceId, conn.id), setSecret)}>
              {t("newSecret")}
            </Button>
          )}
        </div>
        {conn.eventPreset === "slack" && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => setEventSecretAction(workspaceId, conn.id, pasted), (value) => {
                setSecret(value);
                setPasted("");
              });
            }}
          >
            <Input value={pasted} type="password" autoComplete="off" onChange={(e) => setPasted(e.target.value)} placeholder={t("slackSecret")} className="min-w-0 flex-1" />
            <Button size="sm" type="submit" disabled={pending || !pasted.trim()}>
              {tc("save")}
            </Button>
          </form>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("triggers")}</h3>
        <p className="text-xs text-fg-muted">{t("triggersHelp")}</p>
        {triggers === null ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : (
          <>
            {triggers.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {triggers.map((trigger) => (
                  <li key={trigger.id} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        {t("triggerLine", { agent: agentName(trigger.agentId), event: trigger.eventType ?? t("anyEvent") })}
                      </p>
                      {trigger.prompt && <p className="line-clamp-2 text-xs text-fg-muted">{trigger.prompt}</p>}
                      <label className="mt-1 flex items-start gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5 accent-accent"
                          checked={trigger.trusted}
                          disabled={pending}
                          onChange={(e) =>
                            run(() => updateTriggerAction(workspaceId, trigger.id, { trusted: e.target.checked }), (view) => setTriggers((all) => all?.map((x) => (x.id === view.id ? view : x)) ?? all))
                          }
                        />
                        <span>{t("trusted")}</span>
                      </label>
                      <p className={cn("text-xs", trigger.trusted ? "text-danger" : "text-fg-muted")}>{trigger.trusted ? t("trustedOn") : t("trustedOff")}</p>
                    </div>
                    <Switch
                      checked={trigger.enabled}
                      label={t("enabled")}
                      disabled={pending}
                      onChange={(enabled) =>
                        run(() => updateTriggerAction(workspaceId, trigger.id, { enabled }), (view) => setTriggers((all) => all?.map((x) => (x.id === view.id ? view : x)) ?? all))
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => run(() => deleteTriggerAction(workspaceId, trigger.id), () => setTriggers((all) => all?.filter((x) => x.id !== trigger.id) ?? all))}
                    >
                      {tc("remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <NewTrigger
              workspaceId={workspaceId}
              connectionId={conn.id}
              agents={agents}
              onAdded={(view) => setTriggers((all) => [...(all ?? []), view])}
            />
          </>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-medium">{t("recent")}</h3>
          <Button size="sm" variant="ghost" onClick={() => setVersion((v) => v + 1)}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("reload")}
          </Button>
        </div>
        {events === null ? (
          <p className="text-sm text-fg-muted">{tc("loading")}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("none")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {events.map((event) => (
              <li key={event.id} className="flex items-baseline gap-3 px-3 py-1.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{event.eventType}</span>
                <span className="shrink-0 text-xs text-fg-muted">
                  {event.status === "queued"
                    ? t("queued", { n: Number(event.note) || 1 })
                    : event.status === "received"
                      ? t("received")
                      : t(`ignored.${event.note === "noMatch" ? "noMatch" : "noTrigger"}`)}
                </span>
                <time className="shrink-0 text-xs text-fg-faint" dateTime={event.receivedAt}>
                  {format.dateTime(new Date(event.receivedAt), { dateStyle: "short", timeStyle: "short" })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function NewTrigger({
  workspaceId,
  connectionId,
  agents,
  onAdded,
}: {
  workspaceId: string;
  connectionId: string;
  agents: ConnectionAgent[];
  onAdded: (view: ConnectionTriggerView) => void;
}) {
  const t = useTranslations("settings.connections.events");
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "");
  const [eventType, setEventType] = useState("");
  const [prompt, setPrompt] = useState("");
  const [trusted, setTrusted] = useState(false);
  const { pending, error, run } = useAction();

  if (!agents.length) return <p className="text-sm text-fg-muted">{t("noAgents")}</p>;
  return (
    <form
      className="space-y-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => createTriggerAction(workspaceId, connectionId, { agentId, eventType: eventType.trim() || null, prompt, trusted }), (view) => {
          onAdded(view);
          setEventType("");
          setPrompt("");
          setTrusted(false);
        });
      }}
    >
      <div className="flex flex-wrap gap-2">
        <label className="min-w-40 flex-1 space-y-1">
          <span className="text-xs text-fg-muted">{t("agent")}</span>
          <select className={cn(selectClass, "w-full")} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.icon ? `${agent.icon} ` : ""}
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-40 flex-1 space-y-1">
          <span className="text-xs text-fg-muted">{t("eventType")}</span>
          <Input value={eventType} maxLength={MAX_TRIGGER_EVENT} onChange={(e) => setEventType(e.target.value)} placeholder={t("eventTypePlaceholder")} />
        </label>
      </div>
      <label className="block space-y-1">
        <span className="text-xs text-fg-muted">{t("prompt")}</span>
        <textarea className={textareaClass} rows={2} maxLength={MAX_AGENT_PROMPT} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("promptPlaceholder")} />
      </label>
      <div className="space-y-0.5">
        <label className="flex items-start gap-1.5 text-sm">
          <input type="checkbox" className="mt-1 accent-accent" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          <span>{t("trusted")}</span>
        </label>
        <p className={cn("text-xs", trusted ? "text-danger" : "text-fg-muted")}>{trusted ? t("trustedOn") : t("trustedOff")}</p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button size="sm" type="submit" variant="primary" disabled={pending || !agentId}>
        {t("addTrigger")}
      </Button>
    </form>
  );
}

function SettingsTab({
  workspaceId,
  conn,
  onChange,
  onDeleted,
}: {
  workspaceId: string;
  conn: ConnectionView;
  onChange: (view: ConnectionView) => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("settings.connections");
  const tc = useTranslations("common");
  const [name, setName] = useState(conn.name);
  const [url, setUrl] = useState(conn.url);
  const [authType, setAuthType] = useState(conn.authType);
  const [token, setToken] = useState("");
  // The owner's own app (the instance's isn't theirs to change here, only to replace).
  const savedClientId = conn.oauthClient && !conn.oauthClient.fromInstance ? conn.oauthClient.clientId : "";
  const [clientId, setClientId] = useState(savedClientId);
  const [clientSecret, setClientSecret] = useState("");
  const [eventPreset, setEventPreset] = useState(conn.eventPreset);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saved, setSaved] = useState(false);
  const { pending, error, run } = useAction();
  const setup = useContext(OAuthSetupContext);
  const moved = url.trim() !== conn.url;
  const entry = catalogEntryFor(url.trim());
  const clientMode = clientModeOf(authType, entry, setup);
  // A saved secret goes only to the address it was given for: a new one needs it typed again.
  const secretKept = !moved && Boolean(conn.oauthClient?.hasSecret) && clientId.trim() === savedClientId && Boolean(savedClientId);
  const clientChanged = authType === "oauth" && (clientId.trim() !== savedClientId || clientSecret !== "" || (moved && Boolean(savedClientId)));
  const clientMissing =
    clientMode === "required" && (!clientId.trim() || (!entry?.client?.secretOptional && !clientSecret.trim() && !secretKept));
  const reconnects = moved || authType !== conn.authType || token !== "" || clientChanged;

  return (
    <div className="space-y-6">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          run(
            () =>
              updateConnectionAction(workspaceId, conn.id, {
                name,
                url,
                authType,
                eventPreset,
                ...(authType === "token" && (token || authType !== conn.authType) ? { token } : {}),
                ...(clientChanged ? { oauthClient: clientId.trim() ? { clientId, clientSecret } : null } : {}),
              }),
            (view) => {
              onChange(view);
              setToken("");
              setClientId(view.oauthClient && !view.oauthClient.fromInstance ? view.oauthClient.clientId : "");
              setClientSecret("");
              setSaved(true);
            },
          );
        }}
      >
        <ConnectionFields
          name={name}
          url={url}
          authType={authType}
          token={token}
          eventPreset={eventPreset}
          onName={setName}
          onUrl={setUrl}
          onAuthType={setAuthType}
          onToken={setToken}
          onEventPreset={setEventPreset}
          tokenRequired={conn.authType !== "token" || url.trim() !== conn.url}
        >
          {clientMode && (
            <OAuthClientFields
              mode={clientMode}
              service={entry}
              clientId={clientId}
              clientSecret={clientSecret}
              onClientId={setClientId}
              onClientSecret={setClientSecret}
              secretKept={secretKept}
            />
          )}
        </ConnectionFields>
        {reconnects && <p className="text-xs text-fg-muted">{t("reconnectNote")}</p>}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={pending || !name.trim() || !url.trim() || clientMissing}>
            {tc("save")}
          </Button>
          {saved && !pending && <span className="text-xs text-fg-muted">{tc("saved")}</span>}
        </div>
      </form>
      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-medium">{t("deleteTitle")}</h3>
        <p className="text-xs text-fg-muted">{t("deleteBody")}</p>
        {confirmDelete ? (
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => deleteConnectionAction(workspaceId, conn.id), onDeleted)}>
              {t("deleteConfirm")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              {tc("cancel")}
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(true)}>
            {t("delete")}
          </Button>
        )}
      </section>
    </div>
  );
}
