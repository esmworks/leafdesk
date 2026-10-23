"use client";

import { LoaderCircle, Sparkles, TriangleAlert, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { suggestFormulaAction } from "@/app/actions/ai";
import { Button } from "@/components/ui";
import type { FormulaSuggestion } from "@/server/formula-ai";
import { useFormulaErrorMessage } from "./formula-editor";
import { PropertyDisplay, type ShownProperty } from "./property-cell";
import { HiddenValue } from "./property-access";
import type { Property } from "./types";

/** Longest description sent (server/formula-ai MAX_FORMULA_REQUEST). */
const MAX_DESCRIPTION = 500;

/**
 * The formula editor's "Describe it" box: the person says what the formula should work out, the AI
 * writes it, and the box shows it with what it gives on the first rows. "Use" puts it in the editor,
 * which saves it as usual; nothing is saved from here.
 */
export function FormulaAiBox({
  databaseId,
  prop,
  name,
  titleName,
  onUse,
  onClose,
}: {
  databaseId: string;
  /** The formula property being edited; null while adding one. */
  prop: Property | null;
  name: string;
  titleName: string;
  onUse: (expression: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("database.formula.ai");
  const tFormula = useTranslations("database.formula");
  const tCommon = useTranslations("common");
  const errorMessage = useFormulaErrorMessage();
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<FormulaSuggestion | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // Only the latest request's answer shows.
  const request = useRef(0);

  const write = async () => {
    const text = description.trim();
    if (!text || pending) return;
    const id = ++request.current;
    setPending(true);
    setFailure(null);
    setResult(null);
    const answer = await suggestFormulaAction({ databaseId, propertyId: prop?.id ?? null, name, description: text, titleName }).catch(() => null);
    if (id !== request.current) return;
    setPending(false);
    if (!answer) setFailure(tCommon("genericError"));
    else if (!answer.ok) setFailure(answer.error);
    else setResult(answer.data);
  };

  // The preview shows values as the saved property would: its number format and the like stay.
  const shown: ShownProperty | null = result?.type
    ? { id: prop?.id ?? "\u0000new", name, type: "formula", options: { ...(prop?.type === "formula" ? prop.options : {}), formula: { type: result.type } } }
    : null;

  return (
    <div className="mb-2 rounded-md border border-border bg-bg-subtle p-2">
      <div className="flex items-center gap-1.5 pb-1.5">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
        <span className="flex-1 truncate text-xs font-medium">{t("title")}</span>
        <button
          type="button"
          aria-label={t("close")}
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        autoFocus
        rows={2}
        value={description}
        maxLength={MAX_DESCRIPTION}
        aria-label={t("description")}
        placeholder={t("placeholder")}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void write();
          }
        }}
        className="block w-full resize-none rounded-md border border-border bg-bg px-2 py-1.5 text-xs leading-5 outline-none placeholder:text-fg-faint focus:border-accent"
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {pending && (
          <span className="inline-flex flex-1 items-center gap-1.5 text-xs text-fg-muted" aria-live="polite">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            {t("writing")}
          </span>
        )}
        <Button size="sm" disabled={!description.trim() || pending} onClick={() => void write()}>
          {result || failure ? t("again") : t("write")}
        </Button>
      </div>

      <div aria-live="polite">
        {failure && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{failure}</span>
          </p>
        )}
        {result?.error && (
          <div className="mt-2 text-xs">
            <p className="flex items-start gap-1.5 text-danger">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>{t("failed", { message: errorMessage(result.error) })}</span>
            </p>
            <code className="mt-1.5 block whitespace-pre-wrap break-words rounded-md border border-border bg-bg px-2 py-1.5 font-mono leading-5 text-fg-muted">
              {result.expression}
            </code>
          </div>
        )}
        {result && !result.error && shown && (
          <div className="mt-2 rounded-md border border-border bg-bg">
            <code className="block whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-xs leading-5">{result.expression}</code>
            <div className="border-t border-border px-2 py-1.5">
              <div className="pb-1 text-[11px] text-fg-faint">{tFormula("result", { type: tFormula(`types.${result.type}`) })}</div>
              {result.preview.length ? (
                <dl className="space-y-0.5">
                  {result.preview.map((row) => (
                    <div key={row.id} className="flex min-w-0 items-center gap-3 text-xs">
                      <dt className="w-2/5 shrink-0 truncate text-fg-muted">{row.title.trim() || tCommon("untitled")}</dt>
                      <dd className="flex min-w-0 flex-1 items-center">
                        {row.hidden ? <HiddenValue /> : <PropertyDisplay prop={shown} value={row.value} />}
                        {!row.hidden && (row.value === null || row.value === "") && <span className="text-fg-faint">{t("emptyValue")}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-xs text-fg-faint">{t("noRows")}</p>
              )}
            </div>
            <div className="flex justify-end border-t border-border p-1.5">
              <Button size="sm" variant="primary" onClick={() => onUse(result.expression)}>
                {t("use")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
