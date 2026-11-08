"use client";

import { CornerDownRight, Loader2, RotateCw } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { isAiErrorCode } from "@/lib/ai";
import type { CatchUp, CatchUpItem } from "@/lib/message-catch-up";
import { messagesPath } from "@/lib/messages";
import { call, MessagesError } from "./store";

/** What to catch up on: a channel's messages after `since` (the seq read to when it opened), or a thread. */
export type CatchUpTarget = { channelId: string; threadId?: string | null; since?: number | null };

/** The AI needs longer than other calls: the fast model reads up to a few hundred messages. */
const CATCH_UP_TIMEOUT_MS = 120_000;

/** Catch-ups shown in this tab, so opening the card again shows the same one until asked again. */
const shown = new Map<string, CatchUp>();
const keyOf = (target: CatchUpTarget) => `${target.channelId}\n${target.threadId ?? ""}\n${target.since ?? ""}`;

type State = { kind: "loading" } | { kind: "done"; catchUp: CatchUp } | { kind: "failed"; message: string };

/** The card under the Catch up button (catch-up-button.tsx): asks the server once, then shows its points. */
export function CatchUpPanel({
  target,
  workspaceId,
  openThread,
  close,
}: {
  target: CatchUpTarget;
  workspaceId: string;
  openThread: (threadId: string, messageId?: string) => void;
  close: () => void;
}) {
  const t = useTranslations("messages");
  const tAi = useTranslations("ai");
  const locale = useLocale();
  const key = keyOf(target);
  const [state, setState] = useState<State>(() => {
    const kept = shown.get(key);
    return kept ? { kind: "done", catchUp: kept } : { kind: "loading" };
  });
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (asked === 0 && shown.has(key)) return;
    let live = true;
    setState({ kind: "loading" });
    call<CatchUp>("catchUp", { channelId: target.channelId, threadId: target.threadId ?? undefined, since: target.since ?? undefined, language: locale }, CATCH_UP_TIMEOUT_MS).then(
      (catchUp) => {
        shown.set(key, catchUp);
        if (live) setState({ kind: "done", catchUp });
      },
      (error: unknown) => {
        if (!live) return;
        const code = error instanceof MessagesError ? error.code : "internal";
        const message =
          code === "ai" && error instanceof MessagesError && isAiErrorCode(error.message)
            ? tAi(`errors.${error.message}`)
            : t(`errors.${(code in ERROR_KEYS ? code : "internal") as keyof typeof ERROR_KEYS}`);
        setState({ kind: "failed", message });
      },
    );
    return () => {
      live = false;
    };
    // `asked` counts the person's "Sum up again"; the texts don't start a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, asked]);

  const jump = (item: CatchUpItem) => {
    if (!item.messageId) return;
    close();
    if (target.threadId) openThread(target.threadId, item.messageId);
    else if (item.threadId) openThread(item.threadId, item.messageId);
    else window.history.pushState(null, "", messagesPath(workspaceId, { channelId: target.channelId, messageId: item.messageId }));
  };

  return (
    <div className="max-h-[70vh] overflow-y-auto p-1" aria-live="polite">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <p className="min-w-0 flex-1 text-xs font-medium text-fg-muted">{target.threadId ? t("catchUp.threadTitle") : t("catchUp.title")}</p>
        {state.kind !== "loading" && (
          <button
            type="button"
            onClick={() => setAsked((n) => n + 1)}
            title={t("catchUp.again")}
            aria-label={t("catchUp.again")}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {state.kind === "loading" ? (
        <p className="flex items-center gap-2 px-2 pt-1 pb-3 text-sm text-fg-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("catchUp.reading")}
        </p>
      ) : state.kind === "failed" ? (
        <p className="px-2 pt-1 pb-3 text-sm text-fg-muted">{state.message}</p>
      ) : state.catchUp.read === 0 ? (
        <p className="px-2 pt-1 pb-3 text-sm text-fg-muted">{t("catchUp.nothing")}</p>
      ) : (
        <div className="pb-1">
          {state.catchUp.summary && <p className="px-2 pb-2 text-sm whitespace-pre-line text-fg">{state.catchUp.summary}</p>}
          <Points title={t("catchUp.questions")} items={state.catchUp.questions} jump={jump} />
          <Points title={t("catchUp.decisions")} items={state.catchUp.decisions} jump={jump} />
          <Points title={t("catchUp.open")} items={state.catchUp.open} jump={jump} />
          <p className="px-2 pt-2 text-xs text-fg-faint">
            {t("catchUp.from", { count: state.catchUp.read })}
            {state.catchUp.left > 0 && ` · ${t("catchUp.left", { count: state.catchUp.left })}`}
          </p>
        </div>
      )}
    </div>
  );
}

/** The error texts a call may answer with (messages.errors). */
const ERROR_KEYS = {
  notFound: 1,
  notAllowed: 1,
  notMember: 1,
  archived: 1,
  invalid: 1,
  tooLong: 1,
  nameTaken: 1,
  adminsOnly: 1,
  tooMany: 1,
  held: 1,
  policy: 1,
  rateLimited: 1,
  offline: 1,
  timeout: 1,
  ai: 1,
  internal: 1,
} as const;

function Points({ title, items, jump }: { title: string; items: CatchUpItem[]; jump: (item: CatchUpItem) => void }) {
  if (!items.length) return null;
  return (
    <section className="pb-1">
      <h3 className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-fg-muted">{title}</h3>
      <ul>
        {items.map((item, i) => (
          <li key={i}>
            {item.messageId ? (
              <button type="button" onClick={() => jump(item)} className="group flex w-full items-start gap-1.5 rounded-md px-2 py-1 text-start text-sm text-fg hover:bg-bg-hover">
                <span className="min-w-0 flex-1">{item.text}</span>
                <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-faint group-hover:text-fg-muted rtl:-scale-x-100" />
              </button>
            ) : (
              <p className="px-2 py-1 text-sm text-fg">{item.text}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
