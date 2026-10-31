"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Floating } from "@/components/database/floating";
import { read } from "@/components/read";
import { cn } from "@/components/ui";
import type { MailAddress } from "@/lib/mail-client";
import { parseRecipient, splitAddresses, type Recipient } from "./compose-start";

/** Adds what was typed to the field's recipients, an address once. */
function adding(values: Recipient[], typed: string[]) {
  const out = [...values];
  for (const part of typed) {
    const next = parseRecipient(part);
    if (!out.some((r) => r.address.toLowerCase() === next.address.toLowerCase())) out.push(next);
  }
  return out;
}

/**
 * A recipient field: each address a chip, typed or pasted ones taken at a comma, semicolon, Enter
 * or Tab, and people the mailbox has written with suggested as one types (server/mail-client/contacts.ts).
 */
export function RecipientField({
  label,
  values,
  onChange,
  mailboxId,
  inputRef,
  trailing,
  onTyped,
}: {
  label: string;
  values: Recipient[];
  onChange: (values: Recipient[]) => void;
  mailboxId: string;
  inputRef?: Ref<HTMLInputElement>;
  trailing?: ReactNode;
  /** What is typed and not yet a chip: the composer takes it too when sending. */
  onTyped?: (text: string) => void;
}) {
  const t = useTranslations("mail.composer");
  const [text, setText] = useState("");
  const [suggested, setSuggested] = useState<MailAddress[]>([]);
  const [pick, setPick] = useState(0);
  const [field, setField] = useState<HTMLDivElement | null>(null);
  const asked = useRef(0);

  const type = (value: string) => {
    setText(value);
    onTyped?.(value);
  };
  const commit = (parts: string[]) => {
    if (parts.length) onChange(adding(values, parts));
    type("");
    setSuggested([]);
  };

  useEffect(() => {
    const query = text.trim();
    const ask = ++asked.current;
    if (!query || /[,;]/.test(query)) return;
    const timer = setTimeout(() => {
      void read("mailAddresses", { mailboxId, query })
        .then((result) => {
          if (ask !== asked.current || !result.ok) return;
          const taken = new Set(values.map((v) => v.address.toLowerCase()));
          setSuggested(result.data.filter((a) => !taken.has(a.address)));
          setPick(0);
        })
        .catch(() => {});
    }, 120);
    return () => clearTimeout(timer);
  }, [text, mailboxId, values]);

  const choose = (a: MailAddress) => {
    onChange([...values, a]);
    type("");
    setSuggested([]);
  };
  const open = suggested.length > 0 && !!text.trim();

  return (
    <div ref={setField} className="flex min-h-10 items-start gap-2 py-1.5">
      <span className="w-16 shrink-0 pt-1 text-sm text-fg-muted">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {values.map((r, i) => (
          <span
            key={`${r.address}-${i}`}
            title={r.bad ? t("notAnAddress") : r.address}
            className={cn("inline-flex h-7 max-w-full items-center gap-1 rounded-md border ps-2 pe-0.5 text-sm", r.bad ? "border-danger/40 bg-danger/10 text-danger" : "border-border bg-bg-subtle")}
            onDoubleClick={() => {
              onChange(values.filter((_, j) => j !== i));
              type(r.name ? `${r.name} <${r.address}>` : r.address);
            }}
          >
            <span className="truncate">{r.name || r.address}</span>
            <button
              type="button"
              aria-label={t("removeRecipient", { address: r.address })}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-bg-active hover:text-fg"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={text}
          aria-label={label}
          autoComplete="off"
          className="h-7 min-w-16 flex-1 basis-16 bg-transparent text-sm outline-none placeholder:text-fg-faint"
          placeholder={values.length ? "" : t("recipientPlaceholder")}
          onChange={(e) => {
            const value = e.target.value;
            // A comma, semicolon or new line ends an address; a pasted list becomes its chips.
            if (/[,;\n]/.test(value)) {
              const parts = splitAddresses(value);
              const ended = /[,;\n]\s*$/.test(value);
              const rest = ended ? "" : (parts.pop() ?? "");
              if (parts.length) onChange(adding(values, parts));
              type(rest);
            } else type(value);
          }}
          onBlur={() => commit(splitAddresses(text))}
          onKeyDown={(e) => {
            if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggested.length - 1)) % suggested.length);
            } else if ((e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey && text.trim()) {
              e.preventDefault();
              if (open) choose(suggested[pick]);
              else commit(splitAddresses(text));
            } else if (e.key === "Backspace" && !text && values.length) {
              onChange(values.slice(0, -1));
            } else if (e.key === "Escape" && open) {
              e.stopPropagation();
              setSuggested([]);
            }
          }}
        />
      </div>
      {trailing}
      <Floating anchor={field} open={open} onClose={() => setSuggested([])} className="w-80 max-w-[calc(100vw-2rem)]">
        <div role="listbox" aria-label={t("suggestions")}>
          {suggested.map((a, i) => (
            <button
              key={a.address}
              type="button"
              role="option"
              aria-selected={i === pick}
              className={cn("flex w-full flex-col items-start rounded px-2 py-1.5 text-start hover:bg-bg-hover", i === pick && "bg-bg-hover")}
              // The field keeps the focus, so it doesn't take the typed text as an address first.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setPick(i)}
              onClick={() => choose(a)}
            >
              <span className="w-full truncate text-sm">{a.name || a.address}</span>
              {a.name && <span className="w-full truncate text-xs text-fg-muted">{a.address}</span>}
            </button>
          ))}
        </div>
      </Floating>
    </div>
  );
}
