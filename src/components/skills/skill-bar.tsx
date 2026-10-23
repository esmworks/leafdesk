"use client";

import { ScrollText } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { setSkillAction } from "@/app/actions/skills";
import { MAX_SKILL_DESCRIPTION } from "@/lib/skills";

/**
 * Under a skill's title: what the skill is for, which the AI chat's picker, MCP clients and the
 * skills library show. Saved when the field loses focus; Escape puts back the saved text. A row of
 * a skills database keeps it in a property, shown with the others: the bar then says so.
 */
export function SkillBar({
  workspaceId,
  pageId,
  description,
  property,
  editable,
}: {
  workspaceId: string;
  pageId: string;
  description: string;
  /** The skills database property holding the description, or null when the bar holds it. */
  property: string | null;
  editable: boolean;
}) {
  const t = useTranslations("skills.bar");
  const [saved, setSaved] = useState(description);
  const [text, setText] = useState(description);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // Someone else's change arrives with the header: take it unless this field is being edited.
  useEffect(() => {
    setSaved(description);
    if (document.activeElement !== field.current) setText(description);
  }, [description]);

  const save = async () => {
    const next = text.trim();
    if (next === saved) return;
    setSaving(true);
    setError(null);
    const result = await setSkillAction(pageId, { description: next });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSaved(next);
    setText(next);
  };

  return (
    <div className="mt-3 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <ScrollText className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
        <span className="shrink-0 font-medium">{t("label")}</span>
        {property !== null ? (
          <p className="min-w-0 flex-1 text-fg-muted">{t("inDatabase", { property })}</p>
        ) : editable ? (
          <textarea
            ref={field}
            rows={1}
            value={text}
            maxLength={MAX_SKILL_DESCRIPTION}
            aria-label={t("description")}
            placeholder={t("placeholder")}
            disabled={saving}
            onChange={(e) => setText(e.target.value.replace(/\n/g, " "))}
            onBlur={() => void save()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                setText(saved);
                setError(null);
                requestAnimationFrame(() => field.current?.blur());
              }
            }}
            className="min-w-0 flex-1 resize-none bg-transparent text-fg-muted outline-none [field-sizing:content] placeholder:text-fg-faint focus:text-fg"
          />
        ) : (
          <p className="min-w-0 flex-1 text-fg-muted">{saved || <span className="text-fg-faint">{t("none")}</span>}</p>
        )}
        <Link href={`/w/${workspaceId}/skills`} className="shrink-0 text-fg-muted hover:text-fg hover:underline max-sm:hidden">
          {t("library")}
        </Link>
      </div>
      {error && (
        <p role="alert" className="mt-1 ps-6 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
