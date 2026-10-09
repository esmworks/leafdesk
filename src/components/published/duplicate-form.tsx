"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { duplicatePublishedAction } from "@/app/actions/site";
import { Button, selectClass } from "@/components/ui";

type Target = { id: string; name: string; icon: string | null };

/** Picks the workspace a published page is copied to, then opens the copy. */
export function DuplicateForm({ pageKey, pageId, targets }: { pageKey: string; pageId: string; targets: Target[] }) {
  const t = useTranslations("publish.duplicate");
  const tc = useTranslations("common");
  const router = useRouter();
  const [workspaceId, setWorkspaceId] = useState(targets[0]?.id ?? "");
  const [asTemplate, setAsTemplate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          try {
            const result = await duplicatePublishedAction({ key: pageKey, pageId, workspaceId, asTemplate });
            if (result.ok) router.push(result.data.url);
            else setError(result.error);
          } catch {
            setError(tc("genericError"));
          }
        });
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">{t("workspace")}</span>
        <select
          className={`${selectClass} w-full`}
          value={workspaceId}
          disabled={pending}
          onChange={(e) => setWorkspaceId(e.target.value)}
        >
          {targets.map((w) => (
            <option key={w.id} value={w.id}>
              {w.icon ? `${w.icon} ${w.name}` : w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={asTemplate}
          disabled={pending}
          onChange={(e) => setAsTemplate(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block">{t("asTemplate")}</span>
          <span className="mt-0.5 block text-xs text-fg-muted">{t("asTemplateHint")}</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={pending || !workspaceId} className="self-start">
        {pending ? t("working") : t("submit")}
      </Button>
    </form>
  );
}
