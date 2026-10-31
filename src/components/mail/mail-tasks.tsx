"use client";

import { ListTodo, RotateCcw, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { addMailTasksAction } from "@/app/actions/mail";
import { streamAi } from "@/components/ai-stream";
import { Button, IconButton } from "@/components/ui";
import { isAiErrorCode } from "@/lib/ai";
import type { MailThreadView } from "@/lib/mail-client";
import { readMailTasks, type MailTask } from "@/lib/mail-tasks";
import { pagePath } from "@/lib/mentions";

type Item = MailTask & { id: number; picked: boolean };
type State =
  | { step: "finding" }
  | { step: "error"; message: string }
  | { step: "list"; items: Item[] }
  | { step: "adding"; items: Item[] }
  | { step: "added"; count: number; pageId: string; row: boolean };

/** The person's own day, YYYY-MM-DD: what "Friday" in the mail is read from, and the daily note it goes to. */
const today = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

/**
 * The tasks the AI finds in a thread (server/mail-client/ai.ts, kind `tasks`), each to tick, word
 * again or leave out, then added as the person's to-dos (server/mail-client/tasks.ts): into the
 * page of the thread's row, or their daily note. Loaded when first asked for.
 */
export function MailTasks({
  workspaceId,
  mailboxId,
  folderId,
  threadId,
  row,
  onClose,
}: {
  workspaceId: string;
  mailboxId: string;
  folderId: string;
  threadId: string;
  row: MailThreadView["row"];
  onClose: () => void;
}) {
  const t = useTranslations("mail.ai.tasks");
  const tm = useTranslations("mail");
  const ta = useTranslations("ai");
  const locale = useLocale();
  const [state, setState] = useState<State>({ step: "finding" });
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  const find = useCallback(async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState({ step: "finding" });
    let text = "";
    try {
      const ended = await streamAi(
        "/api/ai/mail",
        { kind: "tasks", mailboxId, folderId, threadId, language: locale, today: today() },
        { signal: controller.signal, onText: (piece) => (text += piece) },
      );
      if (!ended.ok) {
        setState({ step: "error", message: ended.code === "mail" ? tm("ai.mailFailed") : ta(`errors.${isAiErrorCode(ended.code) ? ended.code : "provider"}`) });
        return;
      }
      const tasks = readMailTasks(text);
      if (!tasks) setState({ step: "error", message: t("unreadable") });
      else setState({ step: "list", items: tasks.map((task, id) => ({ ...task, id, picked: true })) });
    } catch {
      if (!controller.signal.aborted) setState({ step: "error", message: ta("errors.provider") });
    } finally {
      if (abort.current === controller) abort.current = null;
    }
  }, [mailboxId, folderId, threadId, locale, t, tm, ta]);

  useEffect(() => {
    void find();
    return () => abort.current?.abort();
  }, [find]);

  const day = (date: string) => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const change = (id: number, next: Partial<Item>) =>
    setState((was) => (was.step === "list" ? { ...was, items: was.items.map((item) => (item.id === id ? { ...item, ...next } : item)) } : was));

  const add = async (items: Item[]) => {
    const tasks = items.filter((item) => item.picked && item.text.trim()).map(({ text, date }) => ({ text, date }));
    if (!tasks.length) return;
    setError(null);
    setState({ step: "adding", items });
    const result = await addMailTasksAction({ mailboxId, folderId, threadId, tasks, today: today() }).catch(() => null);
    if (result?.ok) setState({ step: "added", count: result.data.count, pageId: result.data.pageId, row: result.data.row });
    else {
      setState({ step: "list", items });
      setError(result ? result.error : ta("errors.provider"));
    }
  };
  const items = state.step === "list" || state.step === "adding" ? state.items : [];
  const picked = items.filter((item) => item.picked && item.text.trim()).length;

  return (
    <section aria-label={t("title")} className="mx-6 mt-4 rounded-md border border-border px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2 text-xs font-medium text-fg-muted">
        <ListTodo className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="flex-1">{t("title")}</span>
        {state.step === "finding" && <span aria-live="polite">{t("finding")}</span>}
        {(state.step === "list" || state.step === "error") && (
          <IconButton label={t("again")} className="-my-1 h-7 w-7 text-fg-icon" onClick={() => void find()}>
            <RotateCcw className="h-3.5 w-3.5" />
          </IconButton>
        )}
        <IconButton label={t("close")} className="-my-1 h-7 w-7 text-fg-icon" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>

      {state.step === "finding" ? (
        <div className="mt-2 space-y-2" aria-busy>
          {[70, 50].map((w) => (
            <div key={w} className="h-3 animate-pulse rounded bg-bg-hover" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : state.step === "error" ? (
        <p role="alert" className="mt-1.5 text-danger">
          {state.message}
        </p>
      ) : state.step === "added" ? (
        <p className="mt-1.5" aria-live="polite">
          {state.row ? t("addedRow", { row: row?.title || tm("untitledRow") }) : t("addedNote")}{" "}
          <a href={pagePath(workspaceId, state.pageId)} className="font-medium text-accent hover:underline">
            {t("open")}
          </a>
        </p>
      ) : !items.length ? (
        <p className="mt-1.5 text-fg-muted">{t("none")}</p>
      ) : (
        <>
          <ul className="mt-1.5 space-y-0.5">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  aria-label={item.text}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                  checked={item.picked}
                  disabled={state.step === "adding"}
                  onChange={(e) => change(item.id, { picked: e.target.checked })}
                />
                {/* Worded again in place: what is added is what shows. */}
                <input
                  value={item.text}
                  aria-label={t("text")}
                  disabled={state.step === "adding"}
                  onChange={(e) => change(item.id, { text: e.target.value })}
                  className="min-w-0 flex-1 rounded px-1 py-1 outline-none hover:bg-bg-hover focus:bg-bg-hover"
                />
                {item.date && <span className="shrink-0 text-xs text-fg-muted">{day(item.date)}</span>}
              </li>
            ))}
          </ul>
          {error && (
            <p role="alert" className="mt-1.5 text-danger">
              {error}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
            <span className="me-auto text-xs text-fg-muted">{row ? t("toRow", { row: row.title || tm("untitledRow") }) : t("toNote")}</span>
            <Button variant="primary" size="sm" disabled={!picked || state.step === "adding"} onClick={() => void add(items)}>
              {t("add")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
