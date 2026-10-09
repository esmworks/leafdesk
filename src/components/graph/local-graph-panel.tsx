"use client";

import { Maximize2, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { workspaceGraphAction } from "@/app/actions/graph";
import { useChannel } from "@/components/collab/use-channel";
import { IconButton } from "@/components/ui";
import { clusterRows, DEFAULT_FILTER, filterGraph, MAX_DEPTH, type WorkspaceGraph } from "@/lib/graph";
import { useGraphCanvas } from "./graph-view";

/** Changes to the page tree come in bursts (a move, an import); the graph loads again after them. */
const RELOAD_MS = 1000;

/**
 * The page and the pages around it, beside the page: the workspace graph focused on it, one to three
 * steps out. Loaded again when pages are created, renamed, moved or trashed; the full graph is a
 * click away.
 */
export function LocalGraphPanel({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const t = useTranslations("graph");
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [depth, setDepth] = useState(DEFAULT_FILTER.depth);
  const container = useRef<HTMLDivElement>(null);
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined);

  useChannel(`ws:${workspaceId}`, (event) => {
    if (event !== "tree") return;
    clearTimeout(reload.current);
    reload.current = setTimeout(() => setVersion((v) => v + 1), RELOAD_MS);
  });
  useEffect(() => () => clearTimeout(reload.current), []);

  useEffect(() => {
    let current = true;
    workspaceGraphAction(workspaceId)
      .then((loaded) => {
        if (!current) return;
        setGraph(loaded);
        setFailed(false);
      })
      .catch(() => current && setFailed(true));
    return () => {
      current = false;
    };
  }, [workspaceId, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const shown = useMemo(
    // Databases with many rows around the page stand for them; the page itself always shows.
    () => (graph ? clusterRows(filterGraph(graph, { ...DEFAULT_FILTER, focus: pageId, depth }), { keep: new Set([pageId]) }) : { nodes: [], edges: [] }),
    [graph, pageId, depth],
  );
  useGraphCanvas(container, shown, pageId, workspaceId);

  return (
    <aside
      aria-label={t("local.title")}
      className="fixed top-11 right-0 bottom-0 z-30 flex w-full flex-col border-l border-border bg-bg print:hidden md:w-[360px]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="text-sm font-semibold">{t("local.title")}</h2>
        <label className="ml-auto flex items-center gap-1.5 text-sm text-fg-muted">
          {t("depth")}
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            className="h-7 rounded-md border border-border bg-bg px-1.5 text-sm text-fg"
          >
            {Array.from({ length: MAX_DEPTH }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <Link
          href={`/w/${workspaceId}/graph?focus=${encodeURIComponent(pageId)}`}
          aria-label={t("local.openFull")}
          title={t("local.openFull")}
          className="flex h-7 w-7 items-center justify-center rounded-md text-fg-muted hover:bg-bg-hover hover:text-fg"
        >
          <Maximize2 className="h-4 w-4" />
        </Link>
        <IconButton label={t("local.close")} className="h-7 w-7" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={container} className="absolute inset-0" role="img" aria-label={t("local.canvas")} />
        {(failed || (graph && shown.nodes.length <= 1)) && (
          <p className="absolute inset-x-0 bottom-6 px-6 text-center text-sm text-fg-muted">
            {failed ? t("local.failed") : t("local.empty")}
          </p>
        )}
      </div>
    </aside>
  );
}
