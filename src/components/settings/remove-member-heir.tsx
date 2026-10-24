"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { pagesOnlyTheyManageAction } from "@/app/actions/workspaces";
import { cn, selectClass } from "@/components/ui";
import type { WorkspaceRole } from "@/db/schema/app";

type Person = { userId: string; name: string; email: string; role: WorkspaceRole };

/**
 * In the dialog removing someone from the workspace: who takes over the pages only they could
 * manage (and teamspaces nobody else runs), among the owners and members who stay. The owner
 * removing them is picked first; the count of such pages is looked up when the dialog opens.
 */
export function RemoveMemberHeir({
  workspaceId,
  target,
  people,
  currentUserId,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string;
  target: Person;
  /** Everyone in the workspace; the target and guests are left out here. */
  people: Person[];
  currentUserId: string;
  value: string;
  onChange: (userId: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("settings.members");
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    pagesOnlyTheyManageAction(workspaceId, target.userId)
      .then((result) => live && setCount(result.ok ? result.data : null))
      .catch(() => live && setCount(null));
    return () => {
      live = false;
    };
  }, [workspaceId, target.userId]);
  const options = people
    .filter((p) => p.userId !== target.userId && p.role !== "guest")
    .sort((a, b) => Number(b.userId === currentUserId) - Number(a.userId === currentUserId) || (a.name || a.email).localeCompare(b.name || b.email));
  const name = target.name || target.email;
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-bg-subtle p-3">
      <label htmlFor="remove-member-heir" className="block text-sm font-medium">
        {t("heirLabel")}
      </label>
      <p className="text-xs text-fg-muted">
        {count === null ? t("heirHint", { name }) : t("heirCount", { name, count })}
      </p>
      <select
        id="remove-member-heir"
        className={cn(selectClass, "w-full")}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.userId === currentUserId ? t("heirYou", { name: p.name || p.email }) : `${p.name || p.email}${p.name ? ` (${p.email})` : ""}`}
          </option>
        ))}
      </select>
    </div>
  );
}
