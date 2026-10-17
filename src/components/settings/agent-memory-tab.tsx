"use client";

import { Check, Pencil, ShieldCheck, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";
import {
  addAgentMemoryAction,
  deleteAgentMemoryAction,
  keepAgentMemoryAction,
  listAgentMemoryAction,
  updateAgentMemoryAction,
} from "@/app/actions/agents";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, IconButton, Input, pageLabel } from "@/components/ui";
import type { AgentMemoryView, AgentView } from "@/lib/agents";
import { MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";

/**
 * What an agent remembers (server/agents/memory.ts): the notes that go with each of its runs, and
 * the ones its runs proposed, which wait here until an owner keeps (as they are or changed) or
 * dismisses them. Owners also write, change and delete notes.
 */
export function AgentMemoryTab({ workspaceId, agent, memoryOff }: { workspaceId: string; agent: AgentView; memoryOff: boolean }) {
  const t = useTranslations("settings.agents.memory");
  const tc = useTranslations("common");
  const [notes, setNotes] = useState<AgentMemoryView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    listAgentMemoryAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setNotes(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc]);

  const done = (next: AgentMemoryView[]) => {
    setNotes(next);
    setEditing(null);
  };
  const proposed = notes?.filter((n) => n.status === "proposed") ?? [];
  const kept = notes?.filter((n) => n.status === "kept") ?? [];
  const full = kept.length >= MAX_MEMORIES;
  const editable = !agent.archived;

  function add(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || pending) return;
    run(
      () => addAgentMemoryAction(workspaceId, agent.id, draft),
      (next) => {
        done(next);
        setDraft("");
      },
    );
  }

  /** Saves the note being edited: a proposal is kept with its new text, a kept note just changes. */
  function save(event: FormEvent, note: AgentMemoryView) {
    event.preventDefault();
    if (!editing || pending) return;
    const text = editing.text;
    run(() => (note.status === "proposed" ? keepAgentMemoryAction(workspaceId, agent.id, note.id, text) : updateAgentMemoryAction(workspaceId, agent.id, note.id, text)), done);
  }

  const remove = (which: string[] | "kept" | "proposed") => run(() => deleteAgentMemoryAction(workspaceId, agent.id, which), done);

  const editor = (note: AgentMemoryView) =>
    editing?.id === note.id && (
      <form onSubmit={(e) => save(e, note)} className="flex items-center gap-1">
        <Input
          autoFocus
          aria-label={t("editLabel")}
          value={editing.text}
          maxLength={MAX_MEMORY_CHARS}
          onChange={(e) => setEditing({ id: note.id, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Escape cancels the edit, not the dialog.
            e.stopPropagation();
            setEditing(null);
          }}
        />
        <IconButton type="submit" label={note.status === "proposed" ? t("keepEdited") : tc("save")} className="h-8 w-8" disabled={pending || !editing.text.trim()}>
          <Check className="h-4 w-4" />
        </IconButton>
        <IconButton label={tc("cancel")} className="h-8 w-8" onClick={() => setEditing(null)}>
          <X className="h-4 w-4" />
        </IconButton>
      </form>
    );

  return (
    <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      <p className="flex gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <span>{t("rule")}</span>
      </p>
      {memoryOff && (
        <p className="text-sm text-fg-muted">
          {t.rich("off", {
            link: (chunks) => (
              <Link href={`/w/${workspaceId}/settings?tab=general`} className="text-fg underline underline-offset-2 hover:text-accent">
                {chunks}
              </Link>
            ),
          })}
        </p>
      )}
      {agent.archived && <p className="text-sm text-fg-muted">{t("archived")}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!notes ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : (
        <>
          {proposed.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className="flex-1 text-sm font-medium">{t("proposedHeading", { count: proposed.length })}</h3>
                <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => remove("proposed")}>
                  {t("dismissAll")}
                </Button>
              </div>
              <ul aria-label={t("proposedList")} className="divide-y divide-border rounded-md border border-border">
                {proposed.map((note) => (
                  <li key={note.id} className="px-3 py-2 text-sm">
                    {editor(note) || (
                      <div className="flex items-start gap-1">
                        <div className="min-w-0 flex-1 py-1">
                          {note.text === null ? <p className="text-fg-muted">{t(note.run?.othersRun ? "hiddenOthersText" : "hiddenText")}</p> : <p className="break-words">{note.text}</p>}
                          <Origin workspaceId={workspaceId} note={note} />
                        </div>
                        {editable && note.text !== null && (
                          <>
                            <Button size="sm" variant="primary" disabled={pending || full} onClick={() => run(() => keepAgentMemoryAction(workspaceId, agent.id, note.id), done)}>
                              {t("keep")}
                            </Button>
                            <IconButton label={t("edit")} className="h-7 w-7" disabled={pending || full} onClick={() => setEditing({ id: note.id, text: note.text ?? "" })}>
                              <Pencil className="h-3.5 w-3.5" />
                            </IconButton>
                          </>
                        )}
                        <IconButton label={t("dismiss")} className="h-7 w-7 hover:text-danger" disabled={pending} onClick={() => remove([note.id])}>
                          <X className="h-4 w-4" />
                        </IconButton>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {full && editable && <p className="text-xs text-fg-muted">{t("fullToKeep", { max: MAX_MEMORIES })}</p>}
            </section>
          )}

          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t("keptHeading")}</h3>
            {kept.length ? (
              <ul aria-label={t("keptList")} className="divide-y divide-border rounded-md border border-border">
                {kept.map((note) => (
                  <li key={note.id} className="group/note px-3 py-1.5 text-sm">
                    {editor(note) || (
                      <div className="flex items-start gap-1">
                        <p className="min-w-0 flex-1 py-1 break-words">{note.text}</p>
                        {editable && (
                          <IconButton
                            label={t("edit")}
                            className="h-7 w-7 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60"
                            disabled={pending}
                            onClick={() => setEditing({ id: note.id, text: note.text ?? "" })}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </IconButton>
                        )}
                        <IconButton
                          label={t("delete")}
                          className="h-7 w-7 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-60 hover:text-danger"
                          disabled={pending}
                          onClick={() => remove([note.id])}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </IconButton>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{t("empty")}</p>
            )}
            {editable && (
              <form onSubmit={add} className="flex gap-2">
                <Input
                  aria-label={t("addLabel")}
                  placeholder={full ? t("full", { max: MAX_MEMORIES }) : t("addPlaceholder")}
                  value={draft}
                  maxLength={MAX_MEMORY_CHARS}
                  disabled={full}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button type="submit" variant="primary" disabled={pending || full || !draft.trim()}>
                  {t("add")}
                </Button>
              </form>
            )}
            <div className="flex items-center justify-between gap-2 text-xs text-fg-muted">
              <span>{t("count", { count: kept.length, max: MAX_MEMORIES })}</span>
              {kept.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="hover:text-danger"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(t("confirmForgetAll", { name: agent.name }))) remove("kept");
                  }}
                >
                  {t("forgetAll")}
                </Button>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Where a proposal comes from: the run's row (named when the viewer can open it) or connection, and when. */
function Origin({ workspaceId, note }: { workspaceId: string; note: AgentMemoryView }) {
  const t = useTranslations("settings.agents.memory");
  const tc = useTranslations("common");
  const format = useFormatter();
  const run = note.run;
  const when = format.dateTime(new Date(run?.createdAt ?? note.createdAt), { dateStyle: "medium", timeStyle: "short" });
  if (!run) return <p className="text-xs text-fg-faint">{when}</p>;
  return (
    <p className="text-xs text-fg-faint">
      {run.rowId !== null
        ? run.rowTitle !== null
          ? t.rich("fromRow", {
              row: () => (
                <Link href={`/w/${workspaceId}/p/${run.rowId}`} className="text-fg-muted hover:underline">
                  {pageLabel(run.rowTitle ?? "", tc("untitled"))}
                </Link>
              ),
            })
          : t("fromHiddenRow")
        : run.requested
          ? t("fromRequest")
          : run.scheduled
            ? t("fromSchedule")
            : t("fromConnection", { connection: run.connectionName || t("removedConnection") })}
      {` · ${when}`}
    </p>
  );
}
