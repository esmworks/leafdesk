"use client";

import { CheckCheck, CornerDownRight, Loader2, RotateCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { read } from "@/components/read";
import { Button } from "@/components/ui";
import type { DigestGroup, DigestItem, InboxDigest } from "@/lib/inbox-digest";

type State = { kind: "loading" } | { kind: "done"; digest: InboxDigest } | { kind: "failed"; message: string };

/**
 * The inbox's Catch up (`InboxDialog`'s button): asks the server once for the AI's sorting of the
 * unread notifications, then shows its groups. Opening an item or marking a group read is the
 * person's click; the dialog does both through `onOpen` and `onRead`, which also count them read.
 * A group marked read leaves the list.
 */
export function InboxDigestView({ workspaceId, onOpen, onRead }: { workspaceId: string; onOpen: (item: DigestItem) => void; onRead: (ids: string[]) => void }) {
  const t = useTranslations("sidebar.inbox");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    read("inboxDigest", workspaceId, locale).then(
      (result) => live && setState(result.ok ? { kind: "done", digest: result.data } : { kind: "failed", message: result.error }),
      () => live && setState({ kind: "failed", message: tc("genericError") }),
    );
    return () => {
      live = false;
    };
    // `asked` counts the person's "Sort again"; the texts don't start a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, locale, asked]);

  const markGroup = (group: DigestGroup) => {
    onRead(group.items.map((item) => item.id));
    setState((now) => (now.kind === "done" ? { kind: "done", digest: { ...now.digest, groups: now.digest.groups.filter((g) => g.key !== group.key) } } : now));
  };

  return (
    <div className="max-h-[60vh] overflow-y-auto p-1.5" aria-live="polite">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <p className="min-w-0 flex-1 text-xs font-medium text-fg-muted">{t("digest.title")}</p>
        {state.kind !== "loading" && (
          <button
            type="button"
            onClick={() => setAsked((n) => n + 1)}
            title={t("digest.again")}
            aria-label={t("digest.again")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {state.kind === "loading" ? (
        <p className="flex items-center gap-2 px-2 pt-1 pb-3 text-sm text-fg-muted">
          <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
          {t("digest.reading")}
        </p>
      ) : state.kind === "failed" ? (
        <p role="alert" className="px-2 pt-1 pb-3 text-sm text-fg-muted">
          {state.message}
        </p>
      ) : state.digest.read === 0 ? (
        <p className="px-2 pt-1 pb-3 text-sm text-fg-muted">{t("digest.nothing")}</p>
      ) : (
        <div className="pb-1">
          {state.digest.groups.length === 0 && <p className="px-2 pt-1 pb-2 text-sm text-fg-muted">{t("digest.done")}</p>}
          {state.digest.groups.map((group) => (
            <section key={group.key} className="pb-1.5">
              <div className="flex items-center gap-2 px-2 pt-1.5 pb-0.5">
                <h3 className="min-w-0 flex-1 text-xs font-medium text-fg-muted">
                  {t(`digest.${group.key}`)} <span className="tabular-nums text-fg-faint">{group.items.length}</span>
                </h3>
                <Button size="sm" variant="ghost" className="whitespace-nowrap" onClick={() => markGroup(group)}>
                  <CheckCheck aria-hidden className="h-3.5 w-3.5" />
                  {t("digest.markGroupRead")}
                </Button>
              </div>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => onOpen(item)} className="group flex w-full items-start gap-1.5 rounded-md px-2 py-1.5 text-start hover:bg-bg-hover">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-fg-muted">{item.title}</span>
                        <span className="block text-sm text-fg">{item.text}</span>
                      </span>
                      <CornerDownRight aria-hidden className="mt-1 h-3.5 w-3.5 shrink-0 text-fg-faint group-hover:text-fg-muted rtl:-scale-x-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="px-2 pt-1 text-xs text-fg-faint">
            {t("digest.from", { count: state.digest.read })}
            {state.digest.left > 0 && ` · ${t("digest.left", { count: state.digest.left })}`}
          </p>
        </div>
      )}
    </div>
  );
}
