"use client";

/**
 * Settings > Webhooks (owners): the workspace's page webhooks (server/page-webhooks), each with its
 * events, the pages it covers, who it sends as, a test ping, its signing secret and its recent
 * deliveries; and the form that adds or changes one.
 */
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import {
  createPageWebhookAction,
  deletePageWebhookAction,
  pageWebhookSecretAction,
  testPageWebhookAction,
  updatePageWebhookAction,
  type TestDeliveryView,
} from "@/app/actions/page-webhooks";
import { PagePicker, useShareablePages } from "@/components/settings/agent-page-picker";
import { ConfirmButton } from "@/components/settings/confirm-button";
import { CopyButton } from "@/components/settings/copy-button";
import { Button, cn, Dialog, IconButton, Input, PageIcon, pageLabel, selectClass, Switch } from "@/components/ui";
import { PAGE_WEBHOOK_EVENTS, PAGE_WEBHOOK_SCOPES, type PageWebhookEvent, type PageWebhookScope } from "@/lib/page-webhooks";
import type { PageWebhookDeliveryView, PageWebhookView } from "@/server/page-webhooks/manage";

const EVENT_KEYS = {
  "page.created": "pageCreated",
  "page.updated": "pageUpdated",
  "page.moved": "pageMoved",
  "page.trashed": "pageTrashed",
  "page.restored": "pageRestored",
  "page.deleted": "pageDeleted",
  "comment.created": "commentCreated",
  ping: "ping",
} as const satisfies Record<PageWebhookEvent | "ping", string>;

/** An event's text key: `page.created` reads under `events.pageCreated`. */
const eventKey = (event: string) => EVENT_KEYS[event as keyof typeof EVENT_KEYS] ?? "ping";

type Draft = {
  name: string;
  url: string;
  events: PageWebhookEvent[];
  scope: PageWebhookScope;
  teamspaceId: string | null;
  page: { id: string; title: string; icon: string | null; kind: string } | null;
};

const emptyDraft = (): Draft => ({ name: "", url: "", events: [...PAGE_WEBHOOK_EVENTS], scope: "workspace", teamspaceId: null, page: null });

export function WebhooksPanel({
  workspaceId,
  webhooks,
  deliveries,
  teamspaces,
  exportOff,
}: {
  workspaceId: string;
  webhooks: PageWebhookView[];
  deliveries: Record<string, PageWebhookDeliveryView[]>;
  teamspaces: { id: string; name: string }[];
  exportOff: boolean;
}) {
  const t = useTranslations("settings.webhooks");
  const tc = useTranslations("common");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);

  return (
    <div className="space-y-6">
      {exportOff && <p className="rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg-muted">{t("exportOff")}</p>}
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-fg-muted">{t("count", { count: webhooks.length })}</p>
        <Button variant="primary" size="sm" onClick={() => setEditing({ id: null, draft: emptyDraft() })}>
          {t("add")}
        </Button>
      </div>
      {webhooks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">{t("empty")}</p>
      ) : (
        <ul className="space-y-4">
          {webhooks.map((hook) => (
            <WebhookCard
              key={hook.id}
              workspaceId={workspaceId}
              hook={hook}
              deliveries={deliveries[hook.id] ?? []}
              onEdit={() =>
                setEditing({
                  id: hook.id,
                  draft: { name: hook.name, url: hook.url, events: hook.events, scope: hook.scope, teamspaceId: hook.teamspace?.id ?? null, page: hook.page },
                })
              }
              onSecret={(value) => setSecret({ title: hook.name, value })}
            />
          ))}
        </ul>
      )}
      {editing && (
        <WebhookForm
          workspaceId={workspaceId}
          webhookId={editing.id}
          initial={editing.draft}
          teamspaces={teamspaces}
          onClose={() => setEditing(null)}
          onCreated={(value, name) => setSecret({ title: name, value })}
        />
      )}
      {secret && (
        <Dialog open onClose={() => setSecret(null)} className="max-w-lg">
          <div className="flex items-start gap-2 border-b border-border px-4 py-3">
            <h2 className="min-w-0 flex-1 text-sm font-semibold">{t("secret.title", { name: secret.title })}</h2>
            <IconButton label={tc("close")} onClick={() => setSecret(null)}>
              <X size={14} />
            </IconButton>
          </div>
          <div className="space-y-3 p-4 text-sm">
            <p className="text-fg-muted">{t("secret.note")}</p>
            <div className="flex items-center gap-2">
              <Input readOnly value={secret.value} aria-label={t("secret.label")} onFocus={(e) => e.currentTarget.select()} />
              <CopyButton value={secret.value} />
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function WebhookCard({
  workspaceId,
  hook,
  deliveries,
  onEdit,
  onSecret,
}: {
  workspaceId: string;
  hook: PageWebhookView;
  deliveries: PageWebhookDeliveryView[];
  onEdit: () => void;
  onSecret: (secret: string) => void;
}) {
  const t = useTranslations("settings.webhooks");
  const tc = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [test, setTest] = useState<TestDeliveryView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = <T,>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, then?: (data: T) => void) =>
    startTransition(async () => {
      setError(null);
      const result = await work();
      if (!result.ok) return setError(result.error);
      then?.(result.data);
      router.refresh();
    });

  const scope =
    hook.scope === "teamspace"
      ? t("scopeLabel.teamspace", { name: hook.teamspace?.name ?? "" })
      : hook.scope === "page"
        ? t("scopeLabel.page", { title: pageLabel(hook.page?.title ?? "", tc("untitled")) })
        : t("scopeLabel.workspace");
  const events = hook.events.length === PAGE_WEBHOOK_EVENTS.length ? t("allEvents") : hook.events.map((e) => t(`events.${eventKey(e)}`)).join(", ");

  return (
    <li className="overflow-hidden rounded-xl border border-border bg-bg-subtle/60" data-webhook={hook.id}>
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{hook.name}</h3>
            {hook.paused ? (
              <span className="rounded-md bg-bg-active px-1.5 py-0.5 text-xs text-fg-muted">{t("pausedBadge")}</span>
            ) : !hook.enabled ? (
              <span className="rounded-md bg-bg-active px-1.5 py-0.5 text-xs text-fg-muted">{t("offBadge")}</span>
            ) : null}
          </div>
          <p className="truncate text-sm text-fg-muted" title={hook.url}>
            {hook.url}
          </p>
          <p className="text-xs text-fg-muted">
            {events} · {scope}
          </p>
          <p className="text-xs text-fg-muted">{hook.paused ? t("paused", { name: hook.owner?.name ?? "" }) : t("sendsAs", { name: hook.owner?.name ?? "" })}</p>
        </div>
        <Switch
          checked={hook.enabled}
          disabled={pending}
          label={t("toggle", { name: hook.name })}
          onChange={(enabled: boolean) => act(() => updatePageWebhookAction(workspaceId, hook.id, { enabled }))}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
        <Button size="sm" disabled={pending} onClick={() => act(() => testPageWebhookAction(workspaceId, hook.id), setTest)}>
          {t("test")}
        </Button>
        <Button size="sm" disabled={pending} onClick={onEdit}>
          {t("edit")}
        </Button>
        <Button size="sm" disabled={pending} onClick={() => act(() => pageWebhookSecretAction(workspaceId, hook.id, false), onSecret)}>
          {t("secret.show")}
        </Button>
        <ConfirmButton
          label={t("secret.rotate")}
          note={t("secret.rotateNote")}
          working={t("working")}
          failed={tc("genericError")}
          act={async () => {
            const result = await pageWebhookSecretAction(workspaceId, hook.id, true);
            if (!result.ok) return result.error;
            onSecret(result.data);
            return null;
          }}
        />
        <ConfirmButton
          label={t("delete")}
          note={t("deleteNote")}
          working={t("working")}
          failed={tc("genericError")}
          act={async () => {
            const result = await deletePageWebhookAction(workspaceId, hook.id);
            return result.ok ? null : result.error;
          }}
        />
      </div>
      {(test || error) && (
        <p role="status" className={cn("border-t border-border px-5 py-2 text-xs", error || test?.status !== "delivered" ? "text-danger" : "text-fg-muted")}>
          {error ?? (test && (test.status === "delivered" ? t("testDelivered", { status: test.httpStatus ?? 200 }) : t("testFailed", { reason: reasonText(t, test.code, test.httpStatus) })))}
        </p>
      )}
      <details className="border-t border-border px-5 py-3 text-sm">
        <summary className="cursor-pointer text-fg-muted">{t("log.title", { count: deliveries.length })}</summary>
        {deliveries.length === 0 ? (
          <p className="mt-2 text-xs text-fg-muted">{t("log.empty")}</p>
        ) : (
          <ul className="mt-2 divide-y divide-border text-xs">
            {deliveries.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5">
                <span className="font-medium">{t(`events.${eventKey(d.event)}`)}</span>
                <span className={cn(d.status === "failed" ? "text-danger" : "text-fg-muted")}>{t(`status.${d.status}`)}</span>
                {(d.code || d.httpStatus) && d.status !== "delivered" && <span className="text-fg-muted">{reasonText(t, d.code, d.httpStatus)}</span>}
                {d.attempts > 1 && <span className="text-fg-muted">{t("log.attempts", { count: d.attempts })}</span>}
                {d.nextAttemptAt && <span className="text-fg-muted">{t("log.next", { when: format.dateTime(new Date(d.nextAttemptAt), { timeStyle: "short" }) })}</span>}
                <time className="ms-auto text-fg-faint" dateTime={d.createdAt}>
                  {format.dateTime(new Date(d.createdAt), { dateStyle: "medium", timeStyle: "short" })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

type Translate = ReturnType<typeof useTranslations<"settings.webhooks">>;

function reasonText(t: Translate, code: string | null, httpStatus: number | null) {
  if (code === "http" || (!code && httpStatus)) return t("codes.http", { status: httpStatus ?? 0 });
  return code ? t(`codes.${code as "noAccess"}`) : "";
}

function WebhookForm({
  workspaceId,
  webhookId,
  initial,
  teamspaces,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  webhookId: string | null;
  initial: Draft;
  teamspaces: { id: string; name: string }[];
  onClose: () => void;
  onCreated: (secret: string, name: string) => void;
}) {
  const t = useTranslations("settings.webhooks");
  const tc = useTranslations("common");
  const router = useRouter();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, startTransition] = useTransition();
  const pages = useShareablePages(workspaceId, { anyAccess: true });
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const input = {
        name: draft.name,
        url: draft.url,
        events: draft.events,
        scope: draft.scope,
        teamspaceId: draft.scope === "teamspace" ? draft.teamspaceId : null,
        pageId: draft.scope === "page" ? (draft.page?.id ?? null) : null,
      };
      if (webhookId) {
        const result = await updatePageWebhookAction(workspaceId, webhookId, input);
        if (!result.ok) return setError(result.error);
      } else {
        const result = await createPageWebhookAction(workspaceId, input);
        if (!result.ok) return setError(result.error);
        onCreated(result.data.secret, draft.name.trim());
      }
      router.refresh();
      onClose();
    });

  return (
    <Dialog open onClose={saving ? () => {} : onClose} className="max-w-lg">
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 text-sm font-semibold">{webhookId ? t("form.editTitle") : t("form.title")}</h2>
        <IconButton label={tc("close")} onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <form
        className="max-h-[70vh] space-y-4 overflow-y-auto p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">{t("form.name")}</span>
          <Input value={draft.name} maxLength={100} required autoFocus onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-fg-muted">{t("form.url")}</span>
          <Input type="url" value={draft.url} required placeholder="https://" onChange={(e) => set({ url: e.target.value })} />
          <span className="block text-xs text-fg-muted">{t("form.urlHint")}</span>
        </label>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs text-fg-muted">{t("form.events")}</legend>
          {PAGE_WEBHOOK_EVENTS.map((event) => (
            <label key={event} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-bg-hover">
              <input
                type="checkbox"
                className="accent-accent"
                checked={draft.events.includes(event)}
                onChange={(e) =>
                  set({ events: e.target.checked ? PAGE_WEBHOOK_EVENTS.filter((x) => x === event || draft.events.includes(x)) : draft.events.filter((x) => x !== event) })
                }
              />
              <span className="flex-1">{t(`events.${eventKey(event)}`)}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs text-fg-muted">{t("form.scope")}</legend>
          {PAGE_WEBHOOK_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-2">
              <input type="radio" name="webhook-scope" checked={draft.scope === scope} onChange={() => set({ scope })} />
              <span>{t(`form.scopes.${scope}`)}</span>
            </label>
          ))}
          {draft.scope === "teamspace" && (
            <select
              className={selectClass}
              aria-label={t("form.teamspace")}
              value={draft.teamspaceId ?? ""}
              required
              onChange={(e) => set({ teamspaceId: e.target.value || null })}
            >
              <option value="">{t("form.teamspace")}</option>
              {teamspaces.map((ts) => (
                <option key={ts.id} value={ts.id}>
                  {ts.name}
                </option>
              ))}
            </select>
          )}
          {draft.scope === "page" &&
            (draft.page ? (
              <div className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
                <PageIcon icon={draft.page.icon} kind={draft.page.kind} className="text-sm" />
                <span className="min-w-0 flex-1 truncate">{pageLabel(draft.page.title, tc("untitled"))}</span>
                <Button type="button" size="sm" variant="ghost" onClick={() => set({ page: null })}>
                  {t("form.otherPage")}
                </Button>
              </div>
            ) : (
              <PagePicker pages={pages} label={t("form.pickPage")} empty={t("form.noPages")} onPick={(p) => set({ page: p })} />
            ))}
        </fieldset>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {webhookId ? t("form.save") : t("form.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
