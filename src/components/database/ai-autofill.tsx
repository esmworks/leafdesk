"use client";

/**
 * AI autofill properties (#42) in the database UI: the settings editor (from "+" and a text
 * property's menu), and each cell's pending and failed states with a per-row "Update with AI".
 * Values are ordinary text: the cells are the usual text cells, and people may still edit them.
 */
import { ArrowLeft, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, cn } from "@/components/ui";
import {
  AI_AUTOFILL_MODES,
  AI_LANGUAGES,
  AUTOFILL_BODY,
  AUTOFILL_TITLE,
  checkAutofill,
  isAiErrorCode,
  MAX_AUTOFILL_PROMPT,
  type AiAutofillConfig,
  type AiAutofillMode,
  type AiCellState,
} from "@/lib/ai";
import { PropertyTypeIcon } from "./property-icons";
import { useSchema } from "./schema-context";
import type { Property } from "./types";

export type AiAutofillContextValue = {
  /** AI can run here: available in the workspace, and the server can be reached. */
  enabled: boolean;
  /** Pending and failed values, per row id and property id. */
  states: Record<string, Record<string, AiCellState>>;
  /** Works values out again; omitted where the person can't change the rows. */
  refresh?: (propertyId: string, rowIds: string[]) => void;
};

const AiAutofillContext = createContext<AiAutofillContextValue>({ enabled: false, states: {} });

export const AiAutofillProvider = AiAutofillContext.Provider;

export function useAiAutofill() {
  return useContext(AiAutofillContext);
}

/** A cell of an autofill property, with its AI state and (on hover) "Update with AI". */
export function AiCell({ prop, rowId, readOnly, children }: { prop: Property; rowId: string; readOnly?: boolean; children: ReactNode }) {
  const t = useTranslations("ai");
  const { enabled, states, refresh } = useAiAutofill();
  if (prop.type !== "text" || !prop.options.ai) return <>{children}</>;
  const state = states[rowId]?.[prop.id];
  const canRefresh = !readOnly && enabled && refresh && state?.status !== "pending";
  const reason = state?.status === "error" ? t(`errors.${isAiErrorCode(state.code) ? state.code : "provider"}`) : "";
  return (
    <div className="group/ai relative">
      {children}
      <div className="pointer-events-none absolute inset-e-1 top-[7px] flex items-center gap-0.5">
        {state?.status === "pending" && (
          <span role="status" title={t("autofill.pending")} className="inline-flex h-5 w-5 items-center justify-center rounded bg-bg">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin text-fg-muted" aria-hidden />
            <span className="sr-only">{t("autofill.pending")}</span>
          </span>
        )}
        {state?.status === "error" && (
          <span
            role="img"
            aria-label={t("autofill.failed", { reason })}
            title={t("autofill.failed", { reason })}
            className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded bg-bg"
          >
            <TriangleAlert className="h-3.5 w-3.5 text-danger" aria-hidden />
          </span>
        )}
        {canRefresh && (
          <button
            type="button"
            aria-label={t("autofill.updateRow")}
            title={t("autofill.updateRow")}
            onClick={() => refresh(prop.id, [rowId])}
            className="pointer-events-auto inline-flex h-5 w-5 items-center justify-center rounded border border-border bg-bg text-fg-muted opacity-0 hover:text-fg focus-visible:opacity-100 group-hover/ai:opacity-100 pointer-coarse:opacity-100"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Translated message for an autofill settings problem. */
function useAutofillError() {
  const t = useTranslations("ai.autofill.errors");
  return (check: ReturnType<typeof checkAutofill>) => (check.ok ? null : t(check.code, check.params ?? {}));
}

const selectClass = "h-7 w-full rounded-md border border-border bg-bg px-2 text-sm outline-none focus:border-accent";

/**
 * Sets up what AI fills in: a summary of the row's page, a translation of one of its values, or
 * the person's own prompt with `{Property}` placeholders. Invalid settings can't be saved.
 */
export function AutofillEditor({
  prop,
  name,
  onSave,
  onBack,
}: {
  /** The property being changed; null while adding one. */
  prop: Property | null;
  name: string;
  onSave: (config: AiAutofillConfig) => void;
  onBack?: () => void;
}) {
  const t = useTranslations("ai.autofill");
  const tDatabase = useTranslations("database");
  const locale = useLocale();
  const properties = useSchema();
  const errorOf = useAutofillError();
  const current = prop?.options.ai;
  const others = useMemo(() => properties.filter((p) => p.id !== prop?.id), [properties, prop?.id]);
  const [mode, setMode] = useState<AiAutofillMode>(current?.mode ?? "summary");
  const [language, setLanguage] = useState(current?.language ?? (locale === "en" ? "tr" : "en"));
  const [source, setSource] = useState(current?.source ?? AUTOFILL_TITLE);
  const [prompt, setPrompt] = useState(current?.prompt ?? "");
  const [includeBody, setIncludeBody] = useState(current?.includeBody ?? false);
  const [auto, setAuto] = useState(current?.auto ?? false);
  const [tried, setTried] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const languages = useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {}
    return AI_LANGUAGES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name, locale));
  }, [locale]);

  const check = checkAutofill({ mode, language, source, prompt, includeBody, auto }, others, prop?.id);
  const error = errorOf(check);

  const insert = (placeholder: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? prompt.length;
    const end = el?.selectionEnd ?? prompt.length;
    const snippet = `{${placeholder}}`;
    setPrompt(prompt.slice(0, start) + snippet + prompt.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + snippet.length, start + snippet.length);
    });
  };

  const save = () => {
    setTried(true);
    if (check.ok) onSave(check.config);
  };

  return (
    <div className="w-80 max-w-[calc(100vw-2rem)]">
      <div className="flex items-center gap-1 px-1 pt-1">
        {onBack && (
          <button
            type="button"
            aria-label={t("back")}
            onClick={onBack}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
          >
            <ArrowLeft className="h-3.5 w-3.5 rtl:-scale-x-100" />
          </button>
        )}
        <span className="truncate px-1 text-sm font-medium">{prop ? t("titleFor", { name }) : t("titleNew")}</span>
      </div>
      <div className="space-y-3 p-2">
        <fieldset>
          <legend className="pb-1 text-xs text-fg-muted">{t("mode")}</legend>
          <div className="space-y-0.5">
            {AI_AUTOFILL_MODES.map((m) => (
              <label
                key={m}
                className={cn("flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-bg-hover", mode === m && "bg-bg-hover")}
              >
                <input type="radio" name="ai-mode" checked={mode === m} onChange={() => setMode(m)} className="mt-1 accent-accent" />
                <span className="min-w-0">
                  <span className="block text-sm">{t(`modes.${m}`)}</span>
                  <span className="block text-xs text-fg-muted">{t(`modeHints.${m}`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {mode === "translation" && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-fg-muted">
              {t("source")}
              <select className={cn(selectClass, "mt-1")} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value={AUTOFILL_TITLE}>{t("sourceTitle")}</option>
                <option value={AUTOFILL_BODY}>{t("sourceBody")}</option>
                {others
                  .filter((p) => p.type === "text" || p.type === "url" || p.type === "select" || p.type === "multi_select" || p.type === "status")
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="block text-xs text-fg-muted">
              {t("language")}
              <select className={cn(selectClass, "mt-1")} value={language} onChange={(e) => setLanguage(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {mode === "custom" && (
          <div>
            <label className="block text-xs text-fg-muted" htmlFor="ai-prompt">
              {t("prompt")}
            </label>
            <textarea
              id="ai-prompt"
              ref={area}
              autoFocus
              rows={4}
              maxLength={MAX_AUTOFILL_PROMPT}
              value={prompt}
              placeholder={t("promptPlaceholder")}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  save();
                }
              }}
              className={cn(
                "mt-1 block w-full resize-y rounded-md border bg-bg px-2 py-1.5 text-sm outline-none placeholder:text-fg-faint",
                tried && error ? "border-danger" : "border-border focus:border-accent",
              )}
            />
            <p className="mt-1 text-xs text-fg-faint">{t("promptHint")}</p>
            <div className="mt-1 flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              <PlaceholderButton label={tDatabase("nameColumn")} icon="title" onClick={() => insert(AUTOFILL_TITLE)} />
              {others.map((p) => (
                <PlaceholderButton key={p.id} label={p.name} icon={p.type} onClick={() => insert(p.name)} />
              ))}
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeBody} onChange={(e) => setIncludeBody(e.target.checked)} />
              {t("includeBody")}
            </label>
          </div>
        )}

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>
            {t("auto")}
            <span className="block text-xs text-fg-muted">{t("autoHint")}</span>
          </span>
        </label>

        <p className="text-xs text-fg-faint">{t("privacy")}</p>
        {tried && error && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-danger">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-2">
        <Button size="sm" variant="primary" onClick={save}>
          {prop ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}

function PlaceholderButton({ label, icon, onClick }: { label: string; icon: Property["type"] | "title"; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="inline-flex h-6 max-w-full items-center gap-1 rounded border border-border px-1.5 text-xs text-fg-muted hover:bg-bg-hover hover:text-fg"
    >
      <PropertyTypeIcon type={icon} className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
