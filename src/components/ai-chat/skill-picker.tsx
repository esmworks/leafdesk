"use client";

/**
 * Skills in the AI chat: typing "/" at the start of the empty box lists the workspace's skills the
 * person can open, narrowed by what follows; picking one puts it above the box, and the next
 * question follows its instructions (server/ai-chat.ts).
 */
import { ScrollText, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { listSkillsAction } from "@/app/actions/skills";
import { cn, IconButton, PageIcon, pageLabel } from "@/components/ui";
import { searchFold } from "@/lib/search-fold";
import type { ChatSkillPick } from "./use-chat";

type SkillOption = { id: string; title: string; icon: string | null; description: string };

/** What follows a "/" that starts the box (one line, kept short): the skill looked for, else null. */
export function skillQuery(input: string): string | null {
  const match = /^\/([^\n]{0,60})$/.exec(input);
  return match ? match[1] : null;
}

/** The skills matching `query`: every word in the title or description, titles that start with it first. */
function matching(options: SkillOption[], query: string) {
  const words = searchFold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  const found = options.filter((o) => {
    const text = searchFold(`${o.title} ${o.description}`);
    return words.every((w) => text.includes(w));
  });
  const first = words.join(" ");
  return [...found.filter((o) => searchFold(o.title).startsWith(first)), ...found.filter((o) => !searchFold(o.title).startsWith(first))];
}

export function useSkillPicker({
  workspaceId,
  input,
  disabled,
  onPick,
}: {
  workspaceId: string;
  input: string;
  /** Nothing can be asked now (a skill is already picked, the chat is busy or blocked). */
  disabled: boolean;
  onPick: (skill: ChatSkillPick) => void;
}) {
  const query = disabled ? null : skillQuery(input);
  const [options, setOptions] = useState<SkillOption[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Escape closes the list until the text changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const looking = query !== null;

  // Loaded each time the list opens, so new and changed skills show.
  useEffect(() => {
    if (!looking) return;
    let current = true;
    setOptions(null);
    setFailed(null);
    void listSkillsAction(workspaceId).then((result) => {
      if (!current) return;
      if (result.ok) setOptions(result.data);
      else setFailed(result.error);
    });
    return () => {
      current = false;
    };
  }, [looking, workspaceId]);

  const shown = useMemo(() => (options && query !== null ? matching(options, query) : []), [options, query]);
  useEffect(() => setActive(0), [query]);
  // Once a query matches nothing past its first word, the box is a question again, not a search.
  const open = query !== null && dismissed !== input && (options === null || shown.length > 0 || !/\s/.test(query));

  const pick = (option: SkillOption) => onPick({ id: option.id, title: option.title });

  /** Keys for the list while it's open; true when one was used. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      setDismissed(input);
      return true;
    }
    if (!shown.length) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      pick(shown[Math.min(active, shown.length - 1)]);
      return true;
    }
    return false;
  };

  return { open, options, shown, active, setActive, failed, pick, onKeyDown, workspaceId };
}

export type SkillPicker = ReturnType<typeof useSkillPicker>;

export const SKILL_LIST_ID = "ai-chat-skills";
export const skillOptionId = (id: string) => `ai-chat-skill-${id}`;

/** The list over the box. Mouse down picks, so the box keeps its focus. */
export function SkillList({ picker }: { picker: SkillPicker }) {
  const t = useTranslations("skills.chat");
  const tc = useTranslations("common");
  const list = useRef<HTMLUListElement>(null);
  const { shown, active } = picker;
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (!picker.open) return null;
  return (
    <div className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg border border-border bg-bg shadow-lg">
      <div className="border-b border-border px-3 py-1.5 text-xs text-fg-muted">{t("heading")}</div>
      {picker.failed ? (
        <p className="px-3 py-2 text-sm text-danger">{picker.failed}</p>
      ) : picker.options === null ? (
        <p className="px-3 py-2 text-sm text-fg-muted">{tc("loading")}</p>
      ) : picker.options.length === 0 ? (
        <p className="px-3 py-2 text-sm text-fg-muted">
          {t("none")}{" "}
          <Link href={`/w/${picker.workspaceId}/skills`} className="text-fg underline">
            {t("library")}
          </Link>
        </p>
      ) : shown.length === 0 ? (
        <p className="px-3 py-2 text-sm text-fg-muted">{t("noMatches")}</p>
      ) : (
        <ul ref={list} id={SKILL_LIST_ID} role="listbox" aria-label={t("heading")} className="max-h-64 overflow-y-auto py-1">
          {shown.map((option, i) => (
            <li
              key={option.id}
              id={skillOptionId(option.id)}
              data-index={i}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => picker.setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                picker.pick(option);
              }}
              className={cn("flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm", i === active && "bg-bg-hover")}
            >
              <PageIcon icon={option.icon} kind="page" className="mt-0.5 text-fg-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{pageLabel(option.title, tc("untitled"))}</span>
                {option.description && <span className="block truncate text-xs text-fg-muted">{option.description}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The picked skill, above the box; × takes it off. */
export function SkillChip({ skill, onRemove }: { skill: ChatSkillPick; onRemove: () => void }) {
  const t = useTranslations("skills.chat");
  const tc = useTranslations("common");
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">
      <ScrollText className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{t("using", { title: pageLabel(skill.title, tc("untitled")) })}</span>
      <IconButton label={t("remove")} className="h-5 w-5" onClick={onRemove}>
        <X className="h-3 w-3" />
      </IconButton>
    </div>
  );
}
