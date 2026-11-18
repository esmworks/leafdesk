"use client";

import { Check, Loader2, RotateCw } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createSuggestedSkillAction } from "@/app/actions/skills";
import { read } from "@/components/read";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";
import { withRow } from "@/lib/row-panel";
import type { SkillSuggestion, SkillSuggestions } from "@/lib/skill-suggestions";

type State = { kind: "loading" } | { kind: "done"; found: SkillSuggestions } | { kind: "failed"; message: string };
/** What the person did with a suggestion: made it (the skill's link), is making it, or hid it. */
type Fate = { kind: "creating" } | { kind: "created"; href: string } | { kind: "failed"; message: string } | { kind: "dismissed" };

/**
 * The library's Suggest skills (skills tab): asks the server once when it opens for the AI's
 * proposals from the person's recent questions and edited pages, and lists them. Nothing is made
 * until Create; Dismiss hides a card here only (asking again may propose it again). `onCreated`
 * refreshes the library's list.
 */
export function SkillSuggestionsDialog({ workspaceId, open, onClose, onCreated }: { workspaceId: string; open: boolean; onClose: () => void; onCreated: () => void }) {
  const t = useTranslations("skills.suggest");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [fates, setFates] = useState<Record<string, Fate>>({});
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ kind: "loading" });
    setFates({});
    read("suggestSkills", workspaceId, locale).then(
      (result) => live && setState(result.ok ? { kind: "done", found: result.data } : { kind: "failed", message: result.error }),
      () => live && setState({ kind: "failed", message: tc("genericError") }),
    );
    return () => {
      live = false;
    };
    // `asked` counts the person's "Suggest again"; the texts don't start a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, workspaceId, locale, asked]);

  const fate = (id: string, next: Fate) => setFates((now) => ({ ...now, [id]: next }));

  async function create(suggestion: SkillSuggestion) {
    fate(suggestion.id, { kind: "creating" });
    try {
      const result = await createSuggestedSkillAction(workspaceId, { title: suggestion.title, description: suggestion.description, instructions: suggestion.instructions });
      if (!result.ok) {
        fate(suggestion.id, { kind: "failed", message: result.error });
        return;
      }
      fate(suggestion.id, { kind: "created", href: withRow(`/w/${workspaceId}/p/${result.data.databaseId}`, result.data.id) });
      onCreated();
    } catch {
      fate(suggestion.id, { kind: "failed", message: tc("genericError") });
    }
  }

  const shown = state.kind === "done" ? state.found.suggestions.filter((s) => fates[s.id]?.kind !== "dismissed") : [];

  return (
    <Dialog open={open} onClose={onClose} className="max-w-xl">
      <DialogHeader
        title={t("title")}
        description={t("description")}
        onClose={onClose}
        closeLabel={tc("close")}
        actions={
          state.kind !== "loading" && (
            <button
              type="button"
              onClick={() => setAsked((n) => n + 1)}
              title={t("again")}
              aria-label={t("again")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
            >
              <RotateCw className="h-3.5 w-3.5" />
            </button>
          )
        }
      />
      <DialogBody className="max-h-[60vh] overflow-y-auto" aria-live="polite">
        {state.kind === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
            {t("reading")}
          </p>
        ) : state.kind === "failed" ? (
          <p role="alert" className="text-sm text-fg-muted">
            {state.message}
          </p>
        ) : state.found.questions === 0 && state.found.pages === 0 ? (
          <p className="text-sm text-fg-muted">{t("nothingToRead")}</p>
        ) : (
          <>
            {shown.length === 0 && <p className="text-sm text-fg-muted">{state.found.suggestions.length === 0 ? t("none") : t("allHandled")}</p>}
            <ul className="space-y-3">
              {shown.map((s) => {
                const f = fates[s.id];
                return (
                  <li key={s.id} className="rounded-lg border border-border p-3">
                    <p className="text-sm font-semibold text-fg">{s.title}</p>
                    {s.description && <p className="mt-0.5 text-[13px] text-fg-muted">{s.description}</p>}
                    <details className="mt-2 text-[13px]">
                      <summary className="cursor-pointer text-fg-muted hover:text-fg">{t("instructions")}</summary>
                      <pre className="mt-1.5 max-h-48 overflow-y-auto font-sans text-[13px] whitespace-pre-wrap text-fg">{s.instructions}</pre>
                    </details>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {f?.kind === "created" ? (
                        <>
                          <span className="flex items-center gap-1 text-[13px] text-fg-muted">
                            <Check aria-hidden className="h-3.5 w-3.5" />
                            {t("created")}
                          </span>
                          <Link href={f.href} className="text-[13px] text-accent hover:underline">
                            {t("open")}
                          </Link>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="primary" disabled={f?.kind === "creating"} onClick={() => create(s)}>
                            {f?.kind === "creating" && <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />}
                            {t("create")}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={f?.kind === "creating"} onClick={() => fate(s.id, { kind: "dismissed" })}>
                            {t("dismiss")}
                          </Button>
                        </>
                      )}
                      {f?.kind === "failed" && (
                        <span role="alert" className="text-[13px] text-fg-muted">
                          {f.message}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-fg-faint">{t("from", { questions: state.found.questions, pages: state.found.pages })}</p>
          </>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          {tc("close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
