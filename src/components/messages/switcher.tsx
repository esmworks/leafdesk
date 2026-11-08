"use client";

import { Hash, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { showToast } from "@/components/toast";
import { cn, Dialog } from "@/components/ui";
import { messagesPath } from "@/lib/messages";
import { listRows } from "./messages-sidebar";
import { PersonFace } from "./person";
import { call, useMessages, useView } from "./store";

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

type Item = { key: string; label: string; detail?: string; icon: React.ReactNode; unread: boolean; open: () => void };

/**
 * Jump to a conversation by typing (Mod+Shift+K): the person's channels and conversations, unread
 * first while nothing is typed, then anyone in the workspace (a direct conversation opens).
 */
export function Switcher({ workspaceId, close }: { workspaceId: string; close: () => void }) {
  const t = useTranslations("messages");
  const s = useMessages((x) => x);
  const view = useView();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const items = useMemo<Item[]>(() => {
    const q = fold(query.trim().replace(/^[#@]/, ""));
    const words = { you: t("you"), someone: t("someone") };
    const rows = listRows(s, words);
    const goTo = (id: string) => () => {
      close();
      window.history.pushState(null, "", messagesPath(workspaceId, { channelId: id }));
    };
    const list: Item[] = rows
      .filter((r) => !q || fold(r.title).includes(q))
      .sort((a, b) => (q ? Number(fold(b.title).startsWith(q)) - Number(fold(a.title).startsWith(q)) : Number(b.unread > 0 || b.member.mentions > 0) - Number(a.unread > 0 || a.member.mentions > 0)))
      .map((r) => {
        const others = r.channel.people.filter((id) => id !== s.me);
        return {
          key: r.channel.id,
          label: r.title,
          detail: r.member.mentions ? t("mentionCount", { count: r.member.mentions }) : undefined,
          icon:
            r.channel.kind === "direct" ? (
              <PersonFace s={view} userId={others[0] ?? s.me} size="xs" count={others.length > 1 ? others.length : undefined} />
            ) : r.channel.kind === "private" ? (
              <Lock className="h-4 w-4 text-fg-icon" />
            ) : (
              <Hash className="h-4 w-4 text-fg-icon" />
            ),
          unread: r.unread > 0 && !r.member.muted,
          open: goTo(r.channel.id),
        };
      });
    if (q) {
      // People without a one-to-one conversation listed yet.
      const talkedTo = new Set(rows.filter((r) => r.channel.kind === "direct" && r.channel.people.length === 2).flatMap((r) => r.channel.people));
      for (const p of s.people.values()) {
        if (p.id === s.me || talkedTo.has(p.id) || !(fold(p.name).includes(q) || fold(p.email).includes(q))) continue;
        list.push({
          key: `person:${p.id}`,
          label: p.name || p.email,
          detail: p.agent ? t("agent") : p.email,
          icon: <PersonFace s={view} userId={p.id} size="xs" />,
          unread: false,
          open: () =>
            void call<string>("direct", { userIds: [p.id] }).then(
              (id) => goTo(id)(),
              () => showToast({ message: t("errors.internal") }),
            ),
        });
      }
    }
    return list.slice(0, 12);
  }, [query, s, view, t, workspaceId, close]);

  return (
    <Dialog open onClose={close} className="max-w-lg">
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setPicked((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(items.length, 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            items[picked]?.open();
          }
        }}
        placeholder={t("switcherPlaceholder")}
        aria-label={t("switcherPlaceholder")}
        className="h-12 w-full border-b border-border bg-transparent px-4 text-[15px] text-fg outline-none placeholder:text-fg-faint"
      />
      <div role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
        {items.map((item, i) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={i === picked}
            onMouseEnter={() => setPicked(i)}
            onClick={item.open}
            className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-start text-sm", i === picked && "bg-bg-hover")}
          >
            <span className="flex w-5 justify-center">{item.icon}</span>
            <span className={cn("min-w-0 flex-1 truncate", item.unread ? "font-semibold text-fg" : "text-fg")}>{item.label}</span>
            {item.detail && <span className="truncate text-xs text-fg-faint">{item.detail}</span>}
          </button>
        ))}
        {!items.length && <p className="px-3 py-4 text-sm text-fg-faint">{t("switcherNone")}</p>}
      </div>
    </Dialog>
  );
}
