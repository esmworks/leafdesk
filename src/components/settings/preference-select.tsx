"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { cn } from "@/components/ui";
import { SettingsRow } from "./section";
import { selectClass } from "./workspace-settings";

/**
 * A preference kept for this browser (a cookie set by `save`), picked from a list whose first
 * option, "", follows the browser or system. Shown at once, saved, then the page is refreshed so the
 * server draws it too; if saving fails the value still in effect comes back.
 */
export function PreferenceSelect({
  id,
  title,
  note,
  current,
  options,
  save,
  onApply,
}: {
  id: string;
  title: React.ReactNode;
  note: React.ReactNode;
  current: string | null;
  options: { value: string; label: string; lang?: string }[];
  save: (value: string | null) => Promise<void>;
  /** Shows a value before the server has it (and the previous one again if saving fails). */
  onApply?: (value: string) => void;
}) {
  const tc = useTranslations("common");
  const router = useRouter();
  const [value, setValue] = useState(current ?? "");
  const [error, setError] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <SettingsRow
      title={title}
      htmlFor={id}
      description={error ? <span className="text-danger">{tc("genericError")}</span> : note}
      control={
        <select
          id={id}
          className={cn(selectClass, "min-w-44")}
          value={value}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.value;
            const previous = value;
            setValue(next);
            setError(false);
            onApply?.(next);
            startTransition(async () => {
              try {
                await save(next || null);
                router.refresh();
              } catch {
                setValue(previous);
                onApply?.(previous);
                setError(true);
              }
            });
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} lang={option.lang}>
              {option.label}
            </option>
          ))}
        </select>
      }
    />
  );
}
