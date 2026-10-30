"use client";

import { Globe } from "lucide-react";
import { useTranslations } from "next-intl";
import { SideBox, SideItem } from "@/components/side-box";
import { PageIcon, pageLabel } from "@/components/ui";
import type { AgentChatStepView } from "@/lib/agent-chat";
import type { ChatMessageView, ChatPageView, ChatSourceView, ChatStepView } from "@/lib/ai-chat";

type Opened = NonNullable<ChatPageView>;

/** The pages a conversation's steps made or changed (those the reader can open), the latest first, each once. */
export function changedPages(steps: readonly (ChatStepView | AgentChatStepView)[]): Opened[] {
  const seen = new Map<string, Opened>();
  for (const step of steps) {
    if (step.kind !== "write" || step.outcome !== "done") continue;
    const changed = step.page ?? step.target;
    if (!changed) continue;
    seen.delete(changed.pageId);
    seen.set(changed.pageId, changed);
  }
  return [...seen.values()].reverse();
}

/** The sources a conversation's answers cite (pages the reader can open, web pages), each once, as first cited. */
function citedSources(messages: readonly ChatMessageView[]): ChatSourceView[] {
  const seen = new Map<string, ChatSourceView>();
  for (const m of messages) {
    for (const s of m.sources ?? []) {
      const key = s.pageId ?? s.url;
      if (key && !seen.has(key)) seen.set(key, s);
    }
  }
  return [...seen.values()];
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** What a conversation made or changed: each page once, opened by `onOpen`. Nothing when there is none. */
export function ChangedPagesBox({ pages, onOpen }: { pages: Opened[]; onOpen: (page: Opened) => void }) {
  const t = useTranslations("ai.chat.side");
  const tc = useTranslations("common");
  if (!pages.length) return null;
  return (
    <SideBox title={t("changes")} count={pages.length}>
      {pages.map((p) => (
        <SideItem key={p.pageId} icon={<PageIcon icon={p.icon} kind={p.kind} />} onClick={() => onOpen(p)}>
          <span className="line-clamp-2 break-words">{pageLabel(p.title, tc("untitled"))}</span>
        </SideItem>
      ))}
    </SideBox>
  );
}

/** The AI chat's boxes beside a conversation: the sources its answers cite and the pages it changed. */
export function ChatSide({ messages, onSource }: { messages: readonly ChatMessageView[]; onSource: (source: ChatSourceView) => void }) {
  const t = useTranslations("ai.chat.side");
  const tc = useTranslations("common");
  const sources = citedSources(messages);
  const changed = changedPages(messages.flatMap((m) => m.steps ?? []));
  return (
    <>
      {sources.length > 0 && (
        <SideBox title={t("sources")} count={sources.length}>
          {sources.map((s) =>
            s.url ? (
              <SideItem key={s.url} icon={<Globe className="h-3.5 w-3.5" />} href={s.url} external>
                <span className="line-clamp-2 break-words">{s.title || hostOf(s.url)}</span>
              </SideItem>
            ) : (
              <SideItem key={s.pageId} icon={<PageIcon icon={s.icon} kind={s.kind ?? undefined} />} onClick={() => onSource(s)}>
                <span className="line-clamp-2 break-words">{pageLabel(s.title, tc("untitled"))}</span>
              </SideItem>
            ),
          )}
        </SideBox>
      )}
      <ChangedPagesBox
        pages={changed}
        onOpen={(p) => onSource({ n: 0, pageId: p.pageId, workspaceId: p.workspaceId, title: p.title, icon: p.icon, kind: p.kind, blockId: null })}
      />
    </>
  );
}
