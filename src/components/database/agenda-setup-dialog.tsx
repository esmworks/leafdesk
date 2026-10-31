"use client";

import { CalendarCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, selectClass } from "@/components/ui";
import { AGENDA_PRIORITY_TYPES, AGENDA_STATUS_TYPES, agendaStatusProperty } from "@/lib/agenda";
import type { Property } from "./types";

/** "new": a property made for the agenda as it is created; "": none. */
export type AgendaChoice = { dateBy: string; statusBy: string; priorityBy: string };
export const NEW_PROPERTY = "new";

/**
 * Picks what a new agenda view goes by: its date, what marks a row done (a status or a checkbox)
 * and, if wanted, a priority (a select or status, its first option highest). Where the database's
 * properties may be changed, a missing date or done property can be made right here.
 */
export function AgendaSetupDialog({
  properties,
  canCreate,
  onCancel,
  onCreate,
}: {
  properties: Property[];
  /** New properties may be made (the database isn't locked to the viewer). */
  canCreate: boolean;
  onCancel: () => void;
  onCreate: (choice: AgendaChoice) => void;
}) {
  const t = useTranslations("database.agenda");
  const tc = useTranslations("common");
  const id = useId();
  const dates = properties.filter((p) => p.type === "date");
  const statuses = properties.filter((p) => (AGENDA_STATUS_TYPES as readonly string[]).includes(p.type));
  const priorities = properties.filter((p) => (AGENDA_PRIORITY_TYPES as readonly string[]).includes(p.type));
  const [choice, setChoice] = useState<AgendaChoice>(() => {
    const status = agendaStatusProperty({}, properties);
    return {
      dateBy: dates[0]?.id ?? (canCreate ? NEW_PROPERTY : ""),
      statusBy: status?.id ?? (canCreate ? NEW_PROPERTY : ""),
      priorityBy: "",
    };
  });
  const set = (patch: Partial<AgendaChoice>) => setChoice((c) => ({ ...c, ...patch }));

  const field = (key: keyof AgendaChoice, label: string, hint: string, options: { value: string; label: string }[]) => (
    <div>
      <label htmlFor={`${id}-${key}`} className="block text-sm font-medium">
        {label}
      </label>
      <p id={`${id}-${key}-hint`} className="mt-0.5 text-xs text-fg-muted">
        {hint}
      </p>
      <select
        id={`${id}-${key}`}
        aria-describedby={`${id}-${key}-hint`}
        value={choice[key]}
        onChange={(e) => set({ [key]: e.target.value })}
        className={cn(selectClass, "mt-1.5 w-full")}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );

  const dateOptions = [
    ...dates.map((p) => ({ value: p.id, label: p.name })),
    ...(canCreate ? [{ value: NEW_PROPERTY, label: t("newDateProperty") }] : []),
    ...(!dates.length && !canCreate ? [{ value: "", label: t("none") }] : []),
  ];
  const statusOptions = [
    ...statuses.map((p) => ({ value: p.id, label: p.name })),
    ...(canCreate ? [{ value: NEW_PROPERTY, label: t("newCheckbox", { name: t("defaultDoneProperty") }) }] : []),
    ...(!statuses.length && !canCreate ? [{ value: "", label: t("none") }] : []),
  ];
  const priorityOptions = [{ value: "", label: t("none") }, ...priorities.filter((p) => p.id !== choice.statusBy).map((p) => ({ value: p.id, label: p.name }))];

  return (
    <Dialog open onClose={onCancel} className="max-w-md">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(choice);
        }}
      >
        <DialogHeader title={t("setupTitle")} description={t("setupHint")} icon={<CalendarCheck className="h-4 w-4" />} onClose={onCancel} closeLabel={tc("close")} />
        <DialogBody>
          {field("dateBy", t("dateField"), t("dateFieldHint"), dateOptions)}
          {field("statusBy", t("statusField"), t("statusFieldHint"), statusOptions)}
          {field("priorityBy", t("priorityField"), t("priorityFieldHint"), priorityOptions)}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary">
            {t("create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
