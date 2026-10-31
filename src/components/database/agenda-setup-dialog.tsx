"use client";

import { CalendarCheck } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogHeader, selectClass } from "@/components/ui";
import { AGENDA_PRIORITY_TYPES, AGENDA_STATUS_TYPES, agendaStatusProperty } from "@/lib/agenda";
import type { ViewConfig } from "@/db/schema/app";
import type { Property } from "./types";
import type { DatabaseApi } from "./use-database";

/** "new": a property made for the agenda as it is created; "": none. */
type AgendaChoice = { dateBy: string; statusBy: string; priorityBy: string };
const NEW_PROPERTY = "new";

/**
 * Picks what a new agenda view goes by: its date, what marks a row done (a status or a checkbox)
 * and, if wanted, a priority (a select or status, its first option highest). Where the database's
 * properties may be changed, a missing date or done property can be made right here.
 */
export function AgendaSetupDialog({
  properties,
  canCreate,
  addProperty,
  onCancel,
  onCreate,
}: {
  properties: Property[];
  /** New properties may be made (the database isn't locked to the viewer). */
  canCreate: boolean;
  addProperty: DatabaseApi["addProperty"];
  onCancel: () => void;
  /** The new view's settings, once the properties asked for are made. */
  onCreate: (config: ViewConfig) => void;
}) {
  const t = useTranslations("database.agenda");
  const td = useTranslations("database.calendar");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
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

  /** Makes the date and done properties asked for, under names no other property has, then hands the settings on. */
  const create = async () => {
    setBusy(true);
    const lower = (s: string) => s.toLocaleLowerCase(locale);
    const names = new Set(properties.map((p) => lower(p.name)));
    const made = async (picked: string, base: string, type: "date" | "checkbox") => {
      if (picked !== NEW_PROPERTY) return picked || undefined;
      let name = base;
      for (let i = 2; names.has(lower(name)); i++) name = `${base} ${i}`;
      names.add(lower(name));
      return (await addProperty(name, type))?.id;
    };
    try {
      const dateBy = await made(choice.dateBy, td("defaultDateProperty"), "date");
      const statusBy = await made(choice.statusBy, t("defaultDoneProperty"), "checkbox");
      onCreate({ ...(dateBy ? { dateBy } : {}), ...(statusBy ? { statusBy } : {}), ...(choice.priorityBy ? { priorityBy: choice.priorityBy } : {}) });
    } finally {
      setBusy(false);
    }
  };

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
          if (!busy) void create();
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
          <Button type="submit" variant="primary" disabled={busy}>
            {t("create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
