"use client";

import { Copy, Plus, Trash2, Webhook } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { showToast } from "@/components/toast";
import { Button, Input } from "@/components/ui";
import { call, MessagesError } from "./store";

type Hook = { id: string; name: string; hint: string; createdBy: string | null; createdAt: string; lastUsedAt: string | null };

/**
 * A channel's webhooks, for its admins (server/messages/webhooks.ts): tools that post to a chat's
 * incoming webhook post here instead. A new one's address shows once, to copy.
 */
export function ChannelWebhooks({ channelId }: { channelId: string }) {
  const t = useTranslations("messages.webhooks");
  const format = useFormatter();
  const [hooks, setHooks] = useState<Hook[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: string; url: string } | null>(null);
  // When the list was read: "last posted 3 minutes ago" counts from it.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let live = true;
    void call<Hook[]>("webhooks", { channelId }).then(
      (list) => {
        if (!live) return;
        setHooks(list);
        setNow(new Date());
      },
      () => live && setHooks([]),
    );
    return () => {
      live = false;
    };
  }, [channelId]);

  const fail = (error: unknown) => showToast({ message: error instanceof MessagesError && error.code === "invalid" ? error.message : t("failed") });

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const hook = await call<Hook & { url: string }>("addWebhook", { channelId, name });
      setHooks((list) => [...(list ?? []), hook]);
      setMade({ id: hook.id, url: hook.url });
      setName("");
      setAdding(false);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  };

  const remove = (hook: Hook) => {
    if (!window.confirm(t("removeConfirm", { name: hook.name }))) return;
    void call("removeWebhook", { webhookId: hook.id }).then(() => {
      setHooks((list) => (list ?? []).filter((h) => h.id !== hook.id));
      if (made?.id === hook.id) setMade(null);
    }, fail);
  };

  return (
    <section className="border-b border-border py-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
          <Webhook className="h-3.5 w-3.5" />
          {t("title")}
        </h3>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg">
            <Plus className="h-3.5 w-3.5" />
            {t("add")}
          </button>
        )}
      </div>
      <p className="mb-2 text-xs text-fg-muted">{t("hint")}</p>
      {adding && (
        <form
          className="mb-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} aria-label={t("name")} className="min-w-0 flex-1" />
          <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || busy}>
            {t("create")}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setAdding(false)}>
            {t("cancel")}
          </Button>
        </form>
      )}
      {made && (
        <div className="mb-2 rounded-md border border-border bg-bg-subtle p-2">
          <p className="mb-1.5 text-xs text-fg">{t("copyNow")}</p>
          <div className="flex gap-1.5">
            <Input readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} aria-label={t("address")} className="min-w-0 flex-1 font-mono text-xs" />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(made.url).then(() => showToast({ message: t("copied") }))}
              aria-label={t("copy")}
              title={t("copy")}
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      {hooks === null ? (
        <p className="text-sm text-fg-faint">{t("loading")}</p>
      ) : hooks.length === 0 ? (
        !adding && <p className="text-sm text-fg-faint">{t("none")}</p>
      ) : (
        <ul className="space-y-0.5">
          {hooks.map((h) => (
            <li key={h.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-bg-hover">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{h.name}</span>
                <span className="block truncate text-xs text-fg-faint">
                  …{h.hint} · {h.lastUsedAt ? t("lastUsed", { when: format.relativeTime(new Date(h.lastUsedAt), now) }) : t("neverUsed")}
                </span>
              </span>
              <button type="button" onClick={() => remove(h)} aria-label={t("remove", { name: h.name })} title={t("remove", { name: h.name })} className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-active hover:text-fg">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
