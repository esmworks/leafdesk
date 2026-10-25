"use client";

import { iconPrefix } from "@/lib/icon-value";
import { ClipboardCheck } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import { decidePendingChangesAction, listPendingChangesAction, type ReviewQueue as Queue } from "@/app/actions/review";
import { IconGlyph } from "@/components/builtin-icon";
import { useChannel } from "@/components/collab/use-channel";
import { Button, cn, pageLabel, selectClass } from "@/components/ui";
import type { PendingChangeFilter, PendingChangeView } from "@/lib/pending-changes";
import { ChangeBadge, ChangeBody, ChangeHeadline, ChangeMeta, NowProvider } from "./pending-change";

type Status = "open" | "decided";

/**
 * The "For review" page (/w/[id]/review): the changes agents proposed that the person may see,
 * narrowed by agent, database or row, newest first. Each shows what it would change and why, with
 * Approve, Edit and Dismiss; several can be approved or dismissed at once. It follows the
 * workspace's inbox signal, which every proposal and answer sends.
 */
export function ReviewQueue({
  workspaceId,
  initial,
  filter: initialFilter,
  status: initialStatus,
  now,
}: {
  /** The server's render time, so relative dates render alike on both sides. */
  now: string;
  workspaceId: string;
  initial: Queue;
  filter: PendingChangeFilter;
  status: Status;
}) {
  const t = useTranslations("review");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [queue, setQueue] = useState(initial);
  const [filter, setFilter] = useState(initialFilter);
  const [status, setStatus] = useState<Status>(initialStatus);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const asked = useRef(0);

  const load = useCallback(
    async (nextFilter = filter, nextStatus = status) => {
      const n = ++asked.current;
      try {
        const result = await listPendingChangesAction(workspaceId, nextFilter, nextStatus);
        if (n !== asked.current || !result.ok) return;
        setQueue(result.data);
        setSelected((s) => new Set([...s].filter((id) => result.data.changes.some((c) => c.id === id && c.canApprove))));
      } catch {
        // Offline: the list stays as it was until the next signal.
      }
    },
    [workspaceId, filter, status],
  );

  useChannel(`ws:${workspaceId}`, (event) => {
    if (event === "inbox") void load();
  });

  function change(next: { filter?: PendingChangeFilter; status?: Status }) {
    const f = next.filter ?? filter;
    const s = next.status ?? status;
    setFilter(f);
    setStatus(s);
    setSelected(new Set());
    setNotice(null);
    const params = new URLSearchParams();
    if (f.agentId) params.set("agent", f.agentId);
    if (f.databaseId) params.set("database", f.databaseId);
    if (f.rowId) params.set("row", f.rowId);
    if (s === "decided") params.set("status", "decided");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    void load(f, s);
  }

  const onChanged = useCallback(
    (next: PendingChangeView | null, id: string) => {
      setQueue((q) => ({
        ...q,
        // Answered ones leave the waiting list; a failed or edited one stays, as it is now.
        changes: q.changes.flatMap((c) => (c.id !== id ? [c] : next && (status === "decided" || next.status === "pending" || next.status === "failed") ? [next] : [])),
      }));
      setSelected((s) => {
        const copy = new Set(s);
        copy.delete(id);
        return copy;
      });
    },
    [status],
  );

  const answerable = queue.changes.filter((c) => c.canApprove && (c.status === "pending" || c.status === "failed"));
  const allSelected = answerable.length > 0 && answerable.every((c) => selected.has(c.id));

  async function decide(decision: "approve" | "dismiss") {
    if (!selected.size) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await decidePendingChangesAction([...selected], decision);
      if (!result.ok) setNotice(result.error);
      else {
        const skipped = result.data.filter((o) => !o.ok).length;
        if (skipped) setNotice(t("bulkSkipped", { count: skipped }));
      }
      setSelected(new Set());
      await load();
    } catch {
      setNotice(tc("genericError"));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const copy = new Set(s);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });

  const filtered = Boolean(filter.agentId || filter.databaseId || filter.rowId);
  const groups = useMemo(() => {
    const byDatabase = new Map<string, { database: PendingChangeView["database"]; changes: PendingChangeView[] }>();
    for (const c of queue.changes) {
      const group = byDatabase.get(c.database.id) ?? { database: c.database, changes: [] };
      group.changes.push(c);
      byDatabase.set(c.database.id, group);
    }
    return [...byDatabase.values()];
  }, [queue.changes]);

  const item = (c: PendingChangeView) => (
    <CardItem key={c.id} change={c} workspaceId={workspaceId} selected={selected.has(c.id)} onToggle={toggle} onChanged={onChanged} />
  );

  return (
    <NowProvider initial={now}>
      <div className="mx-auto max-w-3xl px-4 pt-14 pb-12 md:px-6 md:pt-12">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">{t("heading")}</h1>
          <p className="mt-2 text-sm text-fg-muted">{t("description")}</p>
        </header>

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <select
            aria-label={t("filters.agent")}
            className={selectClass}
            value={filter.agentId ?? ""}
            onChange={(e) => change({ filter: { ...filter, agentId: e.target.value || null } })}
          >
            <option value="">{t("filters.allAgents")}</option>
            {queue.facets.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {iconPrefix(a.icon)}
                {a.name}
              </option>
            ))}
          </select>
          <select
            aria-label={t("filters.database")}
            className={selectClass}
            value={filter.databaseId ?? ""}
            onChange={(e) => change({ filter: { ...filter, databaseId: e.target.value || null } })}
          >
            <option value="">{t("filters.allDatabases")}</option>
            {queue.facets.databases.map((d) => (
              <option key={d.id} value={d.id}>
                {iconPrefix(d.icon)}
                {pageLabel(d.title, tc("untitled"))}
              </option>
            ))}
          </select>
          <select aria-label={t("filters.status")} className={selectClass} value={status} onChange={(e) => change({ status: e.target.value as Status })}>
            <option value="open">{t("filters.open")}</option>
            <option value="decided">{t("filters.decided")}</option>
          </select>
          {filter.rowId && (
            <Button size="sm" variant="ghost" onClick={() => change({ filter: { ...filter, rowId: null } })}>
              {t("filters.allRows")}
            </Button>
          )}
          <span className="ms-auto text-sm text-fg-muted" aria-live="polite">
            {t("count", { count: queue.changes.length })}
          </span>
        </div>

        {answerable.length > 0 && (
          <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 border-b border-border bg-bg py-2">
            <label className="flex items-center gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(answerable.map((c) => c.id)))}
              />
              {selected.size ? t("selected", { count: selected.size }) : t("selectAll")}
            </label>
            {selected.size > 0 && (
              <span className="ms-auto flex items-center gap-2">
                <Button size="sm" variant="primary" disabled={busy} onClick={() => decide("approve")}>
                  {t("approveSelected", { count: selected.size })}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => decide("dismiss")}>
                  {t("dismissSelected", { count: selected.size })}
                </Button>
              </span>
            )}
          </div>
        )}
        {notice && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {notice}
          </p>
        )}

        {queue.changes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-fg-muted">
            <ClipboardCheck className="h-5 w-5 text-fg-faint" />
            <p>{filtered ? t("empty.filtered") : status === "open" ? t("empty.open") : t("empty.decided")}</p>
            {filtered && (
              <Button size="sm" variant="secondary" onClick={() => change({ filter: {} })}>
                {t("filters.clear")}
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <section key={g.database.id} aria-label={pageLabel(g.database.title, tc("untitled"))}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
                  {g.database.icon && <span aria-hidden><IconGlyph icon={g.database.icon} /></span>}
                  <span className="truncate">{pageLabel(g.database.title, tc("untitled"))}</span>
                  <span className="font-normal text-fg-muted">{g.changes.length}</span>
                </h2>
                <ul className="space-y-3">{g.changes.map(item)}</ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </NowProvider>
  );
}

type ItemProps = {
  change: PendingChangeView;
  workspaceId: string;
  selected: boolean;
  onToggle: (id: string) => void;
  onChanged: (next: PendingChangeView | null, id: string) => void;
};

function SelectBox({ change, selected, onToggle }: Pick<ItemProps, "change" | "selected" | "onToggle">) {
  const t = useTranslations("review");
  const open = change.status === "pending" || change.status === "failed";
  if (!open || !change.canApprove) return <span className="w-4 shrink-0" />;
  return <input type="checkbox" aria-label={t("select")} className="mt-1.5 shrink-0" checked={selected} onChange={() => onToggle(change.id)} />;
}

/** One change as a card: who and what on top, then why, the values and the answers. The queue groups them by database. */
function CardItem({ change, workspaceId, selected, onToggle, onChanged }: ItemProps) {
  return (
    <li className={cn("rounded-xl border p-4", selected ? "border-accent" : "border-border")}>
      <div className="flex items-start gap-3">
        <SelectBox change={change} selected={selected} onToggle={onToggle} />
        <ChangeBadge change={change} />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-sm text-fg-muted">
              <ChangeHeadline change={change} workspaceId={workspaceId} showDatabase={false} />
            </p>
            <ChangeMeta change={change} workspaceId={workspaceId} />
          </div>
          <ChangeBody change={change} onChanged={onChanged} />
        </div>
      </div>
    </li>
  );
}
