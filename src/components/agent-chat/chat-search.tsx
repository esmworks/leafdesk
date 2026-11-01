"use client";

/**
 * Searching the person's own conversations with an agent, in every place it chats with them (its
 * own chat, the blocks on pages), from the chat's box (agents/chat.ts searchAgentChats, read
 * through `read()`). A hit opens its conversation at the message; one in a chat on a page they
 * can't open shows, but opens nothing. Loaded the first time it opens.
 */
import { Loader2, Search, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { read } from "@/components/read";
import { IconButton } from "@/components/ui";
import type { AgentChatSearchHit } from "@/lib/agent-chat";
import { AGENT_CHAT_SEARCH } from "@/lib/agent-chat-search";

/** How long typing pauses before the search goes. */
const DEBOUNCE_MS = 250;

export function ChatSearch({
  workspaceId,
  agentId,
  agentName,
  onPick,
  onClose,
}: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  onPick: (hit: AgentChatSearchHit) => void;
  onClose: () => void;
}) {
  const t = useTranslations("page.agentChat.search");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AgentChatSearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const q = query.trim();
  useEffect(() => {
    if (q.length < AGENT_CHAT_SEARCH.minChars) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = setTimeout(async () => {
      setBusy(true);
      const res = await read("agentChatSearch", workspaceId, agentId, q).catch(() => null);
      if (!live) return;
      setBusy(false);
      setFailed(!res?.ok);
      setHits(res?.ok ? res.data : []);
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, workspaceId, agentId]);

  return (
    <div className="border-b border-border px-3 py-2" data-agent-chat-search>
      <div className="flex items-center gap-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          maxLength={AGENT_CHAT_SEARCH.maxChars}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // The page's editor around a block never sees the box's keys.
            e.stopPropagation();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("placeholder", { name: agentName })}
          aria-label={t("placeholder", { name: agentName })}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none placeholder:text-fg-faint"
        />
        {busy && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" aria-hidden />}
        <IconButton label={tc("close")} className="h-7 w-7" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {q.length > 0 && q.length < AGENT_CHAT_SEARCH.minChars && <p className="py-1 text-xs text-fg-muted">{t("hint", { min: AGENT_CHAT_SEARCH.minChars })}</p>}
      {failed && <p className="py-1 text-xs text-danger">{tc("genericError")}</p>}
      {hits && !failed && hits.length === 0 && <p className="py-1 text-xs text-fg-muted">{t("empty")}</p>}
      {hits && hits.length > 0 && (
        <ul className="mt-1 max-h-64 space-y-0.5 overflow-y-auto" role="listbox" aria-label={t("results")}>
          {hits.map((hit) => {
            const opens = hit.chatId === null || hit.pageId !== null;
            return (
              <li key={`${hit.conversationId}-${hit.at}-${hit.role}`}>
                <button
                  type="button"
                  disabled={!opens}
                  onClick={() => onPick(hit)}
                  className="block w-full rounded-md px-2 py-1.5 text-start text-sm hover:bg-bg-hover disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
                    <span className="min-w-0 truncate font-medium text-fg">{hit.title}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{hit.chatId === null ? t("inThread") : hit.pageId ? t("onPage") : t("onClosedPage")}</span>
                    <span aria-hidden>·</span>
                    <time dateTime={hit.at} className="shrink-0">
                      {format.dateTime(new Date(hit.at), { dateStyle: "medium" })}
                    </time>
                  </span>
                  <span className="mt-0.5 line-clamp-2 break-words text-fg-muted">
                    {hit.role === "assistant" && <span className="text-fg-faint">{agentName}: </span>}
                    {hit.snippet.before}
                    <mark className="rounded-sm bg-accent/20 text-fg">{hit.snippet.match}</mark>
                    {hit.snippet.after}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
