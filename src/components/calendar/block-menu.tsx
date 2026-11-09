"use client";

import { ArrowUpRight, CircleCheck, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { markAssignedDoneAction } from "@/app/actions/assigned";
import { removeWorkBlockAction } from "@/app/actions/work-blocks";
import { showToast } from "@/components/toast";
import { MenuItem, MenuSeparator, Popover } from "@/components/ui";
import type { CalendarItem } from "@/lib/calendar-items";

/**
 * The menu of time planned for a task (a right click or its ⋯): open the task, mark it done the
 * way My tasks does (a row's status, a to-do ticked) when it can be, and remove the block, which
 * leaves the task as it is. `onChanged` reads the Calendar again after a change.
 */
export function BlockMenu({
  workspaceId,
  item,
  at,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  item: CalendarItem;
  at: { x: number; y: number } | Element;
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations("calendar");
  const router = useRouter();
  const blockId = item.id.slice("block:".length);
  const task = item.task;

  const markDone = async () => {
    onClose();
    if (!task) return;
    const result = await markAssignedDoneAction(task.ref).catch(() => null);
    if (!result?.ok) {
      showToast({ message: result?.error ?? t("blockErrors.failed") });
      return;
    }
    onChanged();
  };
  const remove = async () => {
    onClose();
    const result = await removeWorkBlockAction(workspaceId, blockId).catch(() => ({ ok: false, error: "failed" }) as const);
    if (!result.ok) {
      showToast({ message: t(`blockErrors.${result.error}`) });
      return;
    }
    onChanged();
  };

  return (
    <Popover at={at} align="end" open onOpenChange={(open) => !open && onClose()} trigger={() => null}>
      {item.href && (
        <MenuItem
          icon={<ArrowUpRight className="h-4 w-4" />}
          onClick={() => {
            onClose();
            router.push(item.href!);
          }}
        >
          {t("blockMenu.openTask")}
        </MenuItem>
      )}
      {task?.markable && (
        <MenuItem icon={<CircleCheck className="h-4 w-4" />} onClick={() => void markDone()}>
          {t("blockMenu.markDone")}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={<Trash2 className="h-4 w-4" />} danger onClick={() => void remove()}>
        {t("blockMenu.remove")}
      </MenuItem>
    </Popover>
  );
}
