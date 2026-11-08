"use client";

import { Check, Pencil, Search, ShieldCheck, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";
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
import { editsAgent, type AgentMemoryView, type AgentView } from "@/lib/agents";
import { MAX_MEMORIES, MAX_MEMORY_CHARS } from "@/lib/ai-chat";

/**
 * What an agent remembers (server/agents/memory.ts): the notes that go with each of its runs, and
 * the ones its runs proposed, which wait here until an owner keeps (as they are or changed) or
 * dismisses them; a proposal that is a kept note's new text shows that note, which keeping changes.
 * Owners also write, change and delete notes. Corrections (what someone told the agent it got
 * wrong, kept at once from their chat) are labelled with whose chat it was, and listed first.
 */
export function AgentMemoryTab({ workspaceId, agent, memoryOff }: { workspaceId: string; agent: AgentView; memoryOff: boolean }) {
  const t = useTranslations("settings.agents.memory");
  const tc = useTranslations("common");
  const [notes, setNotes] = useState<AgentMemoryView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const locale = useLocale();
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
  // Corrections first: what someone told the agent it got wrong.
  const kept = [...(notes?.filter((n) => n.status === "kept") ?? [])].sort((a, b) => Number(b.kind === "correction") - Number(a.kind === "correction"));
  const full = kept.length >= MAX_MEMORIES;
  // A search narrows the kept notes to those with every word it has, any case.
  const words = query.toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
  const shown = words.length ? kept.filter((note) => words.every((word) => (note.text ?? "").toLocaleLowerCase(locale).includes(word))) : kept;
  const editable = !agent.archived && editsAgent(agent);
  // Forgetting stays open on an archived agent, not to those who only see it.
  const forgets = editsAgent(agent);

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
      <form onSubmit={(e) => save(e, note)} className="flex min-w-0 flex-1 items-center gap-1">
        <Input
          autoFocus
          aria-label={t("editLabel")}
          value={editing.text}
          maxLength={MAX_MEMORY_CHARS}
          onChange={(e) => setEditing({ id: note.id, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            // Escape cancels the edit alone.
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

  // Shown on hover or focus, always on touch.
  const onHover = "opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100 pointer-coarse:opacity-100";
  const row = "group/note flex flex-col gap-2 rounded-lg p-2.5 text-sm hover:bg-bg-hover sm:flex-row sm:items-start sm:gap-3";

  return (
    <div className={cn("space-y-8", pending && "opacity-70")}>
      <div className="space-y-2">
        <p className="flex gap-2 text-[13px] text-fg-muted">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t("ruleShort")}
        </p>
        {memoryOff && (
          <p className="text-[13px] text-fg-muted">
            {t.rich("off", {
              link: (chunks) => (
                <Link href={`/w/${workspaceId}/settings?tab=general`} className="text-fg underline underline-offset-2 hover:text-accent">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        )}
        {agent.archived && <p className="text-[13px] text-fg-muted">{t("archived")}</p>}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      {!notes ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : (
        <>
          {proposed.length > 0 && (
            <section className="rounded-lg bg-bg-subtle px-4 py-3.5">
              <div className="flex items-center gap-2">
                <h3 className="flex-1 text-sm font-medium">{t("proposedHeading", { count: proposed.length })}</h3>
                {forgets && proposed.length > 1 && (
                  <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => remove("proposed")}>
                    {t("dismissAll")}
                  </Button>
                )}
              </div>
              <ul aria-label={t("proposedList")} className="-mx-2.5 mt-1 flex flex-col gap-0.5">
                {proposed.map((note) => (
                  <li key={note.id} className={row}>
                    {editor(note) || (
                      <>
                        <div className="min-w-0 flex-1">
                          {note.replaces && (
                            <p className="mb-1 text-xs text-fg-muted">
                              {t("replaces")} <span className="break-words line-through">{note.replaces.text}</span>
                            </p>
                          )}
                          {note.text === null ? <p className="text-fg-muted">{t(note.run?.othersRun ? "hiddenOthersText" : "hiddenText")}</p> : <p className="break-words">{note.text}</p>}
                          <p className="mt-1 text-xs text-fg-faint">
                            {note.kind === "correction" && `${t("correction")} · `}
                            <Origin workspaceId={workspaceId} note={note} />
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {editable && note.text !== null && (
                            <>
                              <Button size="sm" disabled={pending || (full && !note.replaces)} onClick={() => run(() => keepAgentMemoryAction(workspaceId, agent.id, note.id), done)}>
                                {t("keep")}
                              </Button>
                              <IconButton label={t("edit")} className="h-7 w-7" disabled={pending || (full && !note.replaces)} onClick={() => setEditing({ id: note.id, text: note.text ?? "" })}>
                                <Pencil className="h-3.5 w-3.5" />
                              </IconButton>
                            </>
                          )}
                          {forgets && (
                            <Button size="sm" variant="ghost" className="hover:text-danger" disabled={pending} onClick={() => remove([note.id])}>
                              {t("dismiss")}
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              {full && editable && <p className="mt-2 text-xs text-fg-muted">{t("fullToKeep", { max: MAX_MEMORIES })}</p>}
            </section>
          )}

          <section>
            <div className="flex items-baseline gap-2">
              <h3 className="text-sm font-medium">{t("keptHeading")}</h3>
              <span className="ms-auto text-xs text-fg-faint tabular-nums">{t("count", { count: kept.length, max: MAX_MEMORIES })}</span>
            </div>
            {kept.length > 0 && (
              <div className="relative mt-2">
                <Search className="pointer-events-none absolute top-1/2 inset-s-2 h-3.5 w-3.5 -translate-y-1/2 text-fg-faint" aria-hidden />
                <Input type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(e) => setQuery(e.target.value)} className="ps-7" />
              </div>
            )}
            {kept.length > 0 && shown.length === 0 ? (
              <p className="mt-2 text-sm text-fg-muted" aria-live="polite">
                {t("noMatch")}
              </p>
            ) : kept.length ? (
              <ul aria-label={t("keptList")} className="-mx-2.5 mt-2 flex flex-col gap-0.5">
                {shown.map((note) => (
                  <li key={note.id} className={row}>
                    {editor(note) || (
                      <>
                        <div className="min-w-0 flex-1">
                          <p className="break-words">{note.text}</p>
                          <p className="mt-1 text-xs text-fg-faint">
                            {note.kind === "correction" ? <CorrectionLabel note={note} /> : <Origin workspaceId={workspaceId} note={note} kept />}
                          </p>
                        </div>
                        <div className={cn("flex shrink-0 items-center gap-0.5", onHover)}>
                          {editable && (
                            <IconButton label={t("edit")} className="h-7 w-7" disabled={pending} onClick={() => setEditing({ id: note.id, text: note.text ?? "" })}>
                              <Pencil className="h-3.5 w-3.5" />
                            </IconButton>
                          )}
                          {forgets && (
                            <IconButton label={t("delete")} className="h-7 w-7 hover:text-danger" disabled={pending} onClick={() => remove([note.id])}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </IconButton>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-fg-muted">{t("empty")}</p>
            )}
            {editable && (
              <form onSubmit={add} className="mt-3 flex gap-2">
                <Input
                  aria-label={t("addLabel")}
                  placeholder={full ? t("full", { max: MAX_MEMORIES }) : t("addPlaceholder")}
                  value={draft}
                  maxLength={MAX_MEMORY_CHARS}
                  disabled={full}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button type="submit" disabled={pending || full || !draft.trim()}>
                  {t("add")}
                </Button>
              </form>
            )}
            {kept.length > 0 && forgets && (
              <div className="mt-8 flex justify-end">
                <Button
                  variant="ghost"
                  className="hover:text-danger"
                  disabled={pending}
                  onClick={() => {
                    if (confirm(t("confirmForgetAll", { name: agent.name }))) remove("kept");
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("forgetAll")}
                </Button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

/** A kept correction: whose chat it came from (when that is known) and when it last changed. */
function CorrectionLabel({ note }: { note: AgentMemoryView }) {
  const t = useTranslations("settings.agents.memory");
  const format = useFormatter();
  const when = format.dateTime(new Date(note.updatedAt), { dateStyle: "medium" });
  return <>{`${note.saidBy?.name ? t("correctionFrom", { name: note.saidBy.name }) : t("correction")} · ${when}`}</>;
}

/**
 * Where a note comes from: the run's row (named when the viewer can open it) or connection, and
 * when; a kept note says when it last changed, and only the date.
 */
function Origin({ workspaceId, note, kept = false }: { workspaceId: string; note: AgentMemoryView; kept?: boolean }) {
  const t = useTranslations("settings.agents.memory");
  const tc = useTranslations("common");
  const format = useFormatter();
  const run = note.run;
  const when = kept
    ? format.dateTime(new Date(note.updatedAt), { dateStyle: "medium" })
    : format.dateTime(new Date(run?.createdAt ?? note.createdAt), { dateStyle: "medium", timeStyle: "short" });
  if (!run) return <>{when}</>;
  return (
    <>
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
    </>
  );
}
