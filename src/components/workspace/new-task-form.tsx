"use client";

import { CalendarDays, Check, Flag, UserPlus } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { addOwnTaskAction } from "@/app/actions/assigned";
import { DayGrid } from "@/components/database/date-day-grid";
import { Button, cn, MenuItem, MenuSeparator, menuFieldClass, Popover } from "@/components/ui";
import { UserAvatar } from "@/components/user-avatar";
import { MAX_OWN_TASK, MAX_TASK_HELPERS, TASK_PRIORITIES, type TaskPriority } from "@/lib/own-tasks";
import { parseQuickAdd, type QuickAddOption } from "@/lib/quick-add";
import { searchFold } from "@/lib/search-fold";
import { TASKS_EVENT } from "@/lib/tasks-event";
import { dayNumber, dayString, weekdayOf } from "@/lib/time-zone";

/** Someone a task can be for. */
export type TaskPerson = { id: string; name: string; image: string | null };

export type NewTaskFormProps = {
  workspaceId: string;
  /** Today on the person's calendar, YYYY-MM-DD. */
  today: string;
  /** The workspace's people besides the person adding (none for a guest). */
  people: TaskPerson[];
  onClose: () => void;
};

/** The flag's color of each priority: the list's options' colors (server/own-tasks.ts). */
export const PRIORITY_COLORS: Record<TaskPriority, string> = { high: "icon-red", medium: "icon-yellow", low: "icon-blue" };

const PRIORITY_PROPERTY = "priority";
const utcDay = (day: number) => new Date(day * 86_400_000);
/** The first day after `from` that is `weekday` (0 is Sunday). */
const nextWeekday = (from: number, weekday: number) => from + ((weekday - weekdayOf(from) + 6) % 7) + 1;

/**
 * The New task form: a title, where a day ("friday"), `#priority` and `@person` typed in it are
 * understood as quick add does for a database's new rows (lib/quick-add.ts), and buttons that set
 * the same three; what a button set wins over what the text says. Enter adds the task and leaves
 * the form open for the next one.
 */
export function NewTaskForm({ workspaceId, today, people, onClose }: NewTaskFormProps) {
  const t = useTranslations("home.myTasks");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  // Undefined until a button sets it: then the text's reading of it no longer counts.
  const [date, setDate] = useState<string | null | undefined>(undefined);
  const [priority, setPriority] = useState<TaskPriority | null | undefined>(undefined);
  const [helpers, setHelpers] = useState<string[]>([]);
  // People named in the text whom the person took off in the menu.
  const [dropped, setDropped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const options = useMemo<QuickAddOption[]>(
    () => TASK_PRIORITIES.map((key) => ({ propertyId: PRIORITY_PROPERTY, optionId: key, name: t(`priority.${key}`) })),
    [t],
  );
  const parsed = parseQuickAdd(text, { locale, today, people, options });
  const typedPriority = parsed.options[0]?.optionId as TaskPriority | undefined;
  // A text that is only a date ("tomorrow") stays as written.
  const title = parsed.title.trim() || text.trim();
  const shownDate = date !== undefined ? date : parsed.title.trim() ? parsed.date : null;
  const shownPriority = priority !== undefined ? priority : (typedPriority ?? null);
  const shownHelpers = [...new Set([...helpers, ...parsed.people])].filter((id) => !dropped.includes(id)).slice(0, MAX_TASK_HELPERS);
  const byId = new Map(people.map((p) => [p.id, p]));

  const dayLabel = (day: string) => {
    const n = dayNumber(day);
    const todayNumber = dayNumber(today);
    if (n === todayNumber) return t("dates.today");
    if (n === todayNumber + 1) return t("dates.tomorrow");
    return format.dateTime(utcDay(n), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  };

  async function add() {
    if (adding || !title) return;
    setAdding(true);
    setError(null);
    try {
      const result = await addOwnTaskAction(workspaceId, { title, date: shownDate, priority: shownPriority, people: shownHelpers });
      if (!result.ok) return setError(result.error);
      setText("");
      setDate(undefined);
      setPriority(undefined);
      setHelpers([]);
      setDropped([]);
      window.dispatchEvent(new Event(TASKS_EVENT));
      router.refresh();
    } catch {
      setError(t("addFailed"));
    } finally {
      setAdding(false);
      input.current?.focus();
    }
  }

  return (
    <div className="rounded-xl border border-border bg-bg shadow-[0_1px_2px_rgb(0_0_0/0.05)] focus-within:border-fg-faint">
      <input
        ref={input}
        autoFocus
        value={text}
        maxLength={MAX_OWN_TASK}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape") {
            e.preventDefault();
            if (text) setText("");
            else onClose();
          }
        }}
        placeholder={t("newTaskPlaceholder")}
        aria-label={t("newTask")}
        aria-describedby="new-task-hint"
        className="h-11 w-full bg-transparent px-3 text-sm text-fg outline-none placeholder:text-fg-faint"
      />
      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        <DateButton today={today} date={shownDate} label={shownDate ? dayLabel(shownDate) : t("date")} onPick={setDate} />
        <PriorityButton priority={shownPriority} onPick={setPriority} />
        {people.length > 0 && (
          <PeopleButton
            people={people}
            chosen={shownHelpers}
            byId={byId}
            onToggle={(id) => {
              if (shownHelpers.includes(id)) {
                setHelpers(helpers.filter((p) => p !== id));
                if (parsed.people.includes(id)) setDropped([...dropped, id]);
              } else {
                setHelpers([...helpers, id]);
                setDropped(dropped.filter((p) => p !== id));
              }
            }}
          />
        )}
        <span id="new-task-hint" className={cn("ms-1 min-w-0 flex-1 truncate text-xs", error ? "text-danger" : "text-fg-faint")} role={error ? "alert" : undefined}>
          {error ?? t("newTaskHint")}
        </span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {tc("cancel")}
        </Button>
        <Button size="sm" variant="primary" disabled={!title || adding} onClick={() => void add()}>
          {t("add")}
        </Button>
      </div>
    </div>
  );
}

const chipClass =
  "inline-flex h-7 max-w-48 items-center gap-1.5 rounded-md px-2 text-xs text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg aria-expanded:bg-bg-hover";

function DateButton({ today, date, label, onPick }: { today: string; date: string | null; label: string; onPick: (date: string | null) => void }) {
  const t = useTranslations("home.myTasks");
  const format = useFormatter();
  const todayNumber = dayNumber(today);
  const friday = nextWeekday(todayNumber - 1, 5);
  const monday = nextWeekday(todayNumber, 1);
  const short = (day: number) => format.dateTime(utcDay(day), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const choices = [
    { label: t("dates.today"), day: todayNumber },
    { label: t("dates.tomorrow"), day: todayNumber + 1 },
    ...(friday > todayNumber + 1 ? [{ label: format.dateTime(utcDay(friday), { weekday: "long", timeZone: "UTC" }), day: friday }] : []),
    { label: t("dates.nextWeek"), day: monday },
  ];
  return (
    <Popover
      className="w-64 p-1"
      trigger={({ open, toggle }) => (
        <button type="button" aria-expanded={open} onClick={toggle} className={cn(chipClass, date && "text-fg")}>
          <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{label}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          {choices.map((choice) => (
            <MenuItem
              key={choice.label}
              active={date === dayString(choice.day)}
              trailing={<span className="text-xs text-fg-faint">{short(choice.day)}</span>}
              onClick={() => {
                onPick(dayString(choice.day));
                close();
              }}
            >
              {choice.label}
            </MenuItem>
          ))}
          <MenuItem
            onClick={() => {
              onPick(null);
              close();
            }}
          >
            {t("dates.none")}
          </MenuItem>
          <MenuSeparator />
          <div className="px-1.5 pt-1 pb-1.5">
            <DayGrid
              start={date}
              end={null}
              today={today}
              single
              onPick={(day) => {
                onPick(day);
                close();
              }}
            />
          </div>
        </>
      )}
    </Popover>
  );
}

function PriorityButton({ priority, onPick }: { priority: TaskPriority | null; onPick: (priority: TaskPriority | null) => void }) {
  const t = useTranslations("home.myTasks");
  return (
    <Popover
      className="w-48"
      trigger={({ open, toggle }) => (
        <button type="button" aria-expanded={open} onClick={toggle} className={cn(chipClass, priority && "text-fg")}>
          <Flag className={cn("h-3.5 w-3.5 shrink-0", priority && PRIORITY_COLORS[priority])} aria-hidden />
          <span className="truncate">{priority ? t(`priority.${priority}`) : t("priorityLabel")}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          {TASK_PRIORITIES.map((key) => (
            <MenuItem
              key={key}
              icon={<Flag className={cn("h-3.5 w-3.5", PRIORITY_COLORS[key])} />}
              trailing={priority === key ? <Check className="h-3.5 w-3.5" /> : null}
              onClick={() => {
                onPick(key);
                close();
              }}
            >
              {t(`priority.${key}`)}
            </MenuItem>
          ))}
          <MenuItem
            icon={<Flag className="h-3.5 w-3.5 text-fg-faint" />}
            trailing={priority === null ? <Check className="h-3.5 w-3.5" /> : null}
            onClick={() => {
              onPick(null);
              close();
            }}
          >
            {t("priority.none")}
          </MenuItem>
        </>
      )}
    </Popover>
  );
}

function PeopleButton({
  people,
  chosen,
  byId,
  onToggle,
}: {
  people: TaskPerson[];
  chosen: string[];
  byId: Map<string, TaskPerson>;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations("home.myTasks");
  const [query, setQuery] = useState("");
  const wanted = searchFold(query.trim());
  const shown = wanted ? people.filter((p) => searchFold(p.name).includes(wanted)) : people;
  const picked = chosen.flatMap((id) => byId.get(id) ?? []);
  return (
    <Popover
      className="w-60"
      trigger={({ open, toggle }) => (
        <button type="button" aria-expanded={open} onClick={toggle} className={cn(chipClass, picked.length > 0 && "text-fg")}>
          {picked.length ? (
            <>
              <span className="flex -space-x-1.5 rtl:space-x-reverse">
                {picked.slice(0, 3).map((p) => (
                  <UserAvatar key={p.id} name={p.name} image={p.image} size="xs" className="ring-2 ring-bg" />
                ))}
              </span>
              <span className="truncate">{picked.length === 1 ? picked[0].name : t("peopleCount", { count: picked.length })}</span>
            </>
          ) : (
            <>
              <UserPlus className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{t("addPeople")}</span>
            </>
          )}
        </button>
      )}
    >
      <div className="p-1 pb-1.5">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("findPerson")}
          aria-label={t("findPerson")}
          className={menuFieldClass}
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {shown.map((p) => (
          <MenuItem
            key={p.id}
            pressed={chosen.includes(p.id)}
            disabled={!chosen.includes(p.id) && chosen.length >= MAX_TASK_HELPERS}
            icon={<UserAvatar name={p.name} image={p.image} size="xs" />}
            trailing={chosen.includes(p.id) ? <Check className="h-3.5 w-3.5" /> : null}
            onClick={() => onToggle(p.id)}
          >
            {p.name}
          </MenuItem>
        ))}
        {!shown.length && <p className="px-2 py-1.5 text-sm text-fg-faint">{t("noPerson")}</p>}
      </div>
      <p className="border-t border-border px-2 pt-1.5 pb-1 text-xs text-fg-faint">{t("peopleNote")}</p>
    </Popover>
  );
}
