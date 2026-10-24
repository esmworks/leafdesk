"use client";

import { useTranslations } from "next-intl";
import { useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui";
import { QuickAddContext, QuickAddParts } from "./quick-add";

/**
 * A card's or a row's title editor; a new row's (inside its view's QuickAddContext) shows what quick
 * add recognises under it, or over what follows it when the row is too short for that (`compact`).
 */
export function CardTitleInput({ initial, onDone, compact }: { initial: string; onDone: (title: string) => void; compact?: boolean }) {
  const t = useTranslations("database.board");
  const quick = useContext(QuickAddContext);
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone(value.trim());
  };
  useEffect(() => input.current?.focus(), []);
  const field = (
    <input
      ref={input}
      value={value}
      placeholder={t("namePlaceholder")}
      aria-label={t("nameLabel")}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") finish();
      }}
      className="w-full bg-transparent text-sm font-medium outline-none placeholder:text-fg-faint"
    />
  );
  if (!quick) return field;
  return (
    <div className={cn(compact && "relative min-w-0 flex-1")}>
      {field}
      <QuickAddParts quick={quick} text={value} floating={compact} />
    </div>
  );
}
