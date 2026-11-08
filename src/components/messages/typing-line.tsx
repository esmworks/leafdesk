"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { draftKey, personName, useMessages } from "./store";

/** Who is typing here now, in one line above the box (it keeps its height, so the box doesn't jump). */
export function TypingLine({ channelId, threadId }: { channelId: string; threadId: string | null }) {
  const t = useTranslations("messages");
  const here = useMessages((s) => s.typing.get(draftKey(channelId, threadId)));
  const people = useMessages((s) => s.people);
  const me = useMessages((s) => s.me);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!here?.size) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [here]);
  const who = [...(here?.entries() ?? [])].filter(([id, until]) => id !== me && until > now).map(([id]) => personName({ people }, id, t("someone")));
  const text =
    who.length === 0 ? "" : who.length === 1 ? t("typingOne", { person: who[0] }) : who.length === 2 ? t("typingTwo", { first: who[0], second: who[1] }) : t("typingMany", { count: who.length });
  return (
    <p aria-live="polite" className="h-5 truncate px-1 text-xs text-fg-muted">
      {text && (
        <>
          <span className="me-1 inline-flex gap-0.5 align-middle" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1 w-1 animate-pulse rounded-full bg-fg-muted" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </span>
          {text}
        </>
      )}
    </p>
  );
}
