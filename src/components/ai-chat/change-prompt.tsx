"use client";

/**
 * A change the AI chat asks to make, shown in the question box's place until the person decides
 * (chat-thread.tsx loads it the first time one is asked, not with every page).
 */
import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { usePropertyTypeLabel } from "@/components/database/property-icons";
import { BlockChanges } from "@/components/page/history-diff";
import { cn } from "@/components/ui";
import type { ChatSourceView } from "@/lib/ai-chat";
import { PROPERTY_TYPES, type PropertyType } from "@/lib/property-types";
import { PageLink } from "./step-line";
import type { ChangeDecision, PendingChange } from "./use-chat";

const DECISIONS: ChangeDecision[] = ["approve", "always", "decline"];
/**
 * A note about the person, and a call to a connection's tool that changes something, are asked
 * about each time: no "don't ask again" (it would turn on Auto, which doesn't cover them).
 */
const EACH_TIME_DECISIONS: ChangeDecision[] = ["approve", "decline"];
const isMemory = (action: PendingChange["action"]) => action.action === "remember" || action.action === "forget";

/**
 * A change the model asks to make, in the box's place: what, where, the values and text it sets,
 * and the choices (1, 2, 3 on the keyboard; Escape says no).
 */
export default function ChangePrompt({
  pending,
  onDecide,
  onSource,
}: {
  pending: PendingChange;
  onDecide: (decision: ChangeDecision) => void;
  onSource: (source: ChatSourceView) => void;
}) {
  const t = useTranslations("ai.chat.approval");
  const typeLabel = usePropertyTypeLabel();
  const first = useRef<HTMLButtonElement>(null);
  const { action } = pending;
  const comment = action.action === "addComment";
  const memory = isMemory(action);
  const call = action.action === "connection";
  const decisions = memory || call ? EACH_TIME_DECISIONS : DECISIONS;
  const question = action.action === "connection" ? t("question.connection", { connection: action.connection?.name ?? "" }) : t(`question.${action.action}`);
  useEffect(() => {
    first.current?.focus();
  }, [pending.id]);

  return (
    <div
      role="group"
      aria-label={question}
      className="rounded-lg border border-accent bg-bg p-3 text-sm shadow-sm"
      onKeyDown={(e) => {
        const chosen = e.key === "Escape" ? "decline" : decisions[Number(e.key) - 1];
        if (!chosen || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        onDecide(chosen);
      }}
    >
      <p className="font-medium">{question}</p>
      <div className="mt-1.5 space-y-1">
        {action.title && comment && (
          <p className="border-s-2 border-border ps-2 text-xs break-words text-fg-muted">“{action.title}”</p>
        )}
        {action.title && !comment && (
          <p className="font-medium break-words text-fg">
            {memory ? (
              `“${action.title}”`
            ) : call ? (
              action.title
            ) : action.previousTitle !== undefined ? (
              <>
                <span className="text-fg-muted line-through decoration-fg-faint">{action.previousTitle || t("empty")}</span> → {action.title}
              </>
            ) : (
              action.title
            )}
          </p>
        )}
        <p className="flex min-w-0 items-center gap-1 text-xs text-fg-muted">
          {memory ? (
            t("memoryHint")
          ) : call ? (
            t("connectionHint", { connection: action.connection?.name ?? "" })
          ) : action.target ? (
            <>
              {t(action.action === "updateRow" ? "row" : action.action === "editPage" || action.action === "createPdf" || comment ? "page" : "in")}
              <PageLink page={action.target} onSource={onSource} />
            </>
          ) : (
            t("topLevel")
          )}
        </p>
        {action.fromFile && <p className="text-xs text-fg-muted">{t("fromFile", { rows: action.fromFile.rows, name: action.fromFile.name })}</p>}
        {action.properties && action.properties.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {action.properties.map((p, i) => (
              <li key={i} className="break-words">
                {p.name && <span className="text-fg-muted">{p.name}: </span>}
                {p.type === "title" ? t("titleColumn") : PROPERTY_TYPES.includes(p.type as PropertyType) ? typeLabel(p.type as PropertyType) : p.type}
                {p.options && p.options.length > 0 && <span className="text-fg-muted"> · {p.options.join(", ")}</span>}
              </li>
            ))}
          </ul>
        )}
        {action.changes.length > 0 && !action.properties && (
          <ul className="space-y-0.5 text-xs">
            {action.changes.map((c, i) => (
              <li key={i} className="break-words">
                <span className="text-fg-muted">{c.property}:</span>{" "}
                {c.before !== undefined && (
                  <>
                    <span className="text-fg-muted line-through decoration-fg-faint">{c.before || t("empty")}</span> →{" "}
                  </>
                )}
                {c.value || <span className="text-fg-muted">{t("cleared")}</span>}
              </li>
            ))}
          </ul>
        )}
        {action.content &&
          (call ? (
            <pre className="max-h-40 overflow-auto rounded bg-bg-subtle px-2 py-1 text-xs break-all whitespace-pre-wrap text-fg-muted">{action.content}</pre>
          ) : (
            <p className="line-clamp-4 rounded bg-bg-subtle px-2 py-1 text-xs whitespace-pre-wrap text-fg-muted">{action.content}</p>
          ))}
        {action.publicForm && (
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Globe className="h-3.5 w-3.5 shrink-0" />
            {t(`publicForm.${action.publicForm}`)}
          </p>
        )}
        {action.diff && action.diff.length > 0 && (
          <div className="max-h-64 space-y-0.5 overflow-y-auto rounded bg-bg-subtle px-1 py-1 text-xs">
            <BlockChanges changes={action.diff} compact />
          </div>
        )}
      </div>
      <div className="mt-2.5 flex flex-col gap-px">
        {decisions.map((d, i) => (
          <button
            key={d}
            ref={i === 0 ? first : undefined}
            type="button"
            onClick={() => onDecide(d)}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none hover:bg-bg-hover focus-visible:bg-bg-hover"
          >
            <span className="w-3 shrink-0 text-xs text-fg-faint tabular-nums">{i + 1}</span>
            <span className={cn(d === "decline" && "text-fg-muted")}>{t(d)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
