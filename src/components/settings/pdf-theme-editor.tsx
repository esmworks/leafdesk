"use client";

import { Sparkles, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { setLetterheadThemeAction, suggestPdfThemeAction } from "@/app/actions/letterheads";
import { Button, Input, textareaClass } from "@/components/ui";
import type { Letterhead } from "@/lib/letterheads";
import { STARTER_LABELS, starterTheme, type StarterLabels } from "@/lib/pdf-theme-starter";
import { parsePdfTheme, type PdfTheme } from "@/lib/pdf-themes";

const pretty = (theme: PdfTheme | null) => (theme ? JSON.stringify(theme, null, 2) : "");

/** What the text holds: no theme (empty), a theme that passes, or what's wrong with it. */
function read(text: string): { ok: true; theme: PdfTheme | null } | { ok: false; problems: string[] } {
  if (!text.trim()) return { ok: true, theme: null };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : "JSON"] };
  }
  const parsed = parsePdfTheme(value);
  return parsed.ok ? { ok: true, theme: parsed.theme } : { ok: false, problems: parsed.problems };
}

/**
 * A letterhead's theme (lib/pdf-themes), for its owners: the AI changes it as they say, or they
 * edit its JSON; each change the AI makes is saved at once (Undo puts the one before back), so the
 * preview beside it, the saved theme on a sample page, follows.
 */
export function PdfThemeEditor({ letterhead, ai, onClose }: { letterhead: Letterhead; ai: boolean; onClose: () => void }) {
  const t = useTranslations("settings.letterheads");
  const tc = useTranslations("common");
  const router = useRouter();
  const id = useId();
  const [text, setText] = useState(() => pretty(letterhead.theme));
  const [saved, setSaved] = useState(() => pretty(letterhead.theme));
  const [before, setBefore] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "ai" | null>(null);
  const [version, setVersion] = useState(() => Date.now());

  /** Saves `next` (the text of a theme, or "" for none); false when it isn't saved. */
  async function store(next: string): Promise<boolean> {
    const parsed = read(next);
    if (!parsed.ok) {
      setProblems(parsed.problems);
      setError(t("errors.theme"));
      return false;
    }
    const result = await setLetterheadThemeAction(letterhead.id, parsed.theme);
    if (!result.ok) {
      setProblems(result.problems ?? []);
      setError(result.error);
      return false;
    }
    const shown = pretty(result.data.theme);
    setText(shown);
    setSaved(shown);
    setVersion(Date.now());
    router.refresh();
    return true;
  }

  async function act(kind: "save" | "ai", fn: () => Promise<void>) {
    setPending(kind);
    setError(null);
    setProblems([]);
    try {
      await fn();
    } catch {
      setError(t("errors.notFound"));
    } finally {
      setPending(null);
    }
  }

  const save = () => act("save", async () => void (await store(text)));

  const changeWithAi = () =>
    act("ai", async () => {
      const current = read(text);
      const result = await suggestPdfThemeAction(letterhead.id, current.ok ? current.theme : null, instruction);
      if (!result.ok) return setError(result.error);
      const previous = saved;
      if (await store(pretty(result.data))) {
        setBefore(previous);
        setInstruction("");
      }
    });

  const undo = () =>
    act("save", async () => {
      if (before !== null && (await store(before))) setBefore(null);
    });

  const startFromQuote = () => {
    const labels = Object.fromEntries(STARTER_LABELS.map((key) => [key, t(`starter.${key}`)])) as StarterLabels;
    setText(pretty(starterTheme(labels)));
    setProblems([]);
    setError(null);
  };

  const busy = pending !== null;
  return (
    <div className="grid gap-5 bg-bg px-5 py-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">
        <div>
          <h3 className="text-sm font-medium">{t("themeTitle", { name: letterhead.name })}</h3>
          <p className="mt-1 text-xs text-fg-muted">{t("themeHelp")}</p>
        </div>
        {ai && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (instruction.trim()) void changeWithAi();
            }}
          >
            <Input
              className="min-w-64 flex-1"
              aria-label={t("aiApply")}
              value={instruction}
              maxLength={1000}
              placeholder={t("aiPlaceholder")}
              onChange={(e) => setInstruction(e.target.value)}
              disabled={busy}
            />
            <Button type="submit" className="shrink-0 whitespace-nowrap" disabled={busy || !instruction.trim()}>
              <Sparkles className="h-3.5 w-3.5" />
              {pending === "ai" ? t("aiWorking") : t("aiApply")}
            </Button>
            {before !== null && (
              <Button variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => void undo()} disabled={busy}>
                <Undo2 className="h-3.5 w-3.5" />
                {t("undo")}
              </Button>
            )}
          </form>
        )}
        <div className="space-y-1.5">
          <label htmlFor={`${id}-json`} className="block text-sm font-medium">
            {t("json")}
          </label>
          <textarea
            id={`${id}-json`}
            className={`${textareaClass} font-mono text-xs leading-relaxed`}
            rows={18}
            spellCheck={false}
            value={text}
            placeholder={t("noTheme")}
            onChange={(e) => {
              setText(e.target.value);
              setProblems([]);
            }}
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          {problems.length > 0 && (
            <ul className="list-disc space-y-0.5 ps-5 text-xs text-danger">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!text.trim() && (
            <Button variant="ghost" onClick={startFromQuote} disabled={busy}>
              {t("starterButton")}
            </Button>
          )}
          {saved && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("removeThemeConfirm", { name: letterhead.name }))) void act("save", async () => void (await store("")));
              }}
            >
              {t("removeTheme")}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tc("close")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || text === saved}>
            {pending === "save" ? tc("saving") : t("saveTheme")}
          </Button>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="text-sm font-medium">{t("previewLabel")}</div>
        <iframe
          key={version}
          title={t("previewLabel")}
          src={`/api/letterheads/${letterhead.id}/preview?v=${version}#toolbar=0&navpanes=0&view=FitH`}
          className="aspect-[1/1.414] w-full rounded border border-border bg-white"
        />
        <p className="text-xs text-fg-muted">{t("previewHelp")}</p>
      </div>
    </div>
  );
}
