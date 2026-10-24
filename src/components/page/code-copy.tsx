"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import styles from "@/components/published/published-body.module.css";

const COPIED_MS = 1_500;

/** The text a code block holds: its inline content's text, as written. */
export function codeText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")).join("");
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The editor's code block: copies what the block holds (its text as written). */
export function CodeCopyButton({ text }: { text: () => string }) {
  const t = useTranslations("common");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      aria-label={copied ? t("copied") : t("copy")}
      title={copied ? t("copied") : t("copy")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={async () => {
        if (!(await copyText(text()))) return;
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      }}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white/50 opacity-0 transition-opacity hover:bg-white/10 hover:text-white/80 focus-visible:opacity-100 group-hover/code:opacity-100 [@media(hover:none)]:opacity-100"
    >
      {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span>{copied ? t("copied") : t("copy")}</span>
    </button>
  );
}

/**
 * Published pages: a Copy button in the corner of every code block of the body (the server's HTML,
 * `pre > code` under `[data-published-html]`). Added once the page is in the browser; the text it
 * copies is the code's own text.
 */
export function PublishedCodeCopy() {
  const t = useTranslations("common");
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    document.querySelectorAll<HTMLPreElement>("[data-published-html] pre").forEach((pre) => {
      if (pre.parentElement?.classList.contains(styles.codeWrap)) return;
      const code = pre.querySelector("code") ?? pre;
      const wrap = document.createElement("div");
      wrap.className = styles.codeWrap;
      pre.before(wrap);
      wrap.append(pre);
      const button = document.createElement("button");
      button.type = "button";
      button.className = styles.codeCopy;
      button.textContent = t("copy");
      button.addEventListener("click", async () => {
        if (!(await copyText(code.textContent ?? ""))) return;
        button.textContent = t("copied");
        timers.push(setTimeout(() => (button.textContent = t("copy")), COPIED_MS));
      });
      wrap.append(button);
    });
    return () => timers.forEach(clearTimeout);
  }, [t]);
  return null;
}
