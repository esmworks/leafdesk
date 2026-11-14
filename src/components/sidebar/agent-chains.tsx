"use client";

import { MoreHorizontal, Pencil, Play, Trash2, Workflow } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState, useTransition } from "react";
import { removeAgentChainAction, runAgentChainAction } from "@/app/actions/agents";
import { lazyPart } from "@/components/lazy-part";
import { read } from "@/components/read";
import { panelHeading, panelSection } from "@/components/sidebar/panel";
import { Button, cn, Dialog, DialogBody, DialogFooter, DialogTitle, IconButton, MenuItem, MenuSeparator, Popover } from "@/components/ui";
import { chainRunning, type AgentChainView } from "@/lib/agent-chains";
import type { SidebarAgent } from "@/server/agents/manage";

const AgentChainDialog = lazyPart(() => import("./agent-chain-dialog").then((m) => m.AgentChainDialog));

/** How often the list is read again while a chain runs, to follow its steps. */
const RUNNING_MS = 5_000;
const WHY = ["nothingNew", "privateRead", "agentGone", "stopped", "lost"] as const;

/**
 * The agents tab's chains of agents (server/agents/chains.ts), under the agents: each with how its
 * latest run went (or when it runs next), opened to change by a click; its menu runs, changes or
 * deletes it. New chain is in the tab's head (sidebar.tsx), which opens the dialog here through
 * `creating`. Loaded with the tab (a lazyPart in sidebar.tsx).
 */
export function AgentChains({
  workspaceId,
  agents,
  offline,
  creating,
  onCreatingDone,
}: {
  workspaceId: string;
  agents: SidebarAgent[];
  offline: boolean;
  /** New chain was chosen in the tab's head. */
  creating: boolean;
  onCreatingDone: () => void;
}) {
  const t = useTranslations("sidebar.agentChains");
  const tc = useTranslations("common");
  const [chains,setChains] = useState<AgentChainView[] | null>(null);
  const [editing, setEditing] = useState<AgentChainView | null>(null);
  const [removing, setRemoving] = useState<AgentChainView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editable = agents.filter((a) => a.edits);

  const load = useCallback(() => {
    read("agentChains", workspaceId)
      .then((result) => result.ok && setChains(result.data))
      .catch(() => {});
  }, [workspaceId]);
  useEffect(() => {
    if (!offline) load();
  }, [load, offline]);
  const running = chains?.some((c) => chainRunning(c.run)) ?? false;
  useEffect(() => {
    if (!running || offline) return;
    const timer = window.setInterval(load, RUNNING_MS);
    return () => window.clearInterval(timer);
  }, [running, offline, load]);

  function act(action: () => Promise<{ ok: true; data: AgentChainView[] } | { ok: false; error: string }>, then?: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setChains(result.data);
          then?.();
        } else setError(result.error);
      } catch {
        setError(tc("genericError"));
      }
    });
  }

  const dialogChain = creating ? null : editing;
  const dialogOpen = creating || editing !== null;
  return (
    <>
      {chains && chains.length > 0 && (
        <section aria-label={t("heading")} className={cn(panelSection, pending && "opacity-70")}>
          <p className={panelHeading}>{t("heading")}</p>
          {error && (
            <p role="alert" className="px-2 pb-1 text-xs text-danger">
              {error}
            </p>
          )}
          <ul className="space-y-0.5">
            {chains.map((chain) => (
              <ChainRow
                key={chain.id}
                chain={chain}
                offline={offline}
                onOpen={() => setEditing(chain)}
                onRun={() => act(() => runAgentChainAction(workspaceId, chain.id))}
                onRemove={() => setRemoving(chain)}
              />
            ))}
          </ul>
        </section>
      )}
      {dialogOpen && (
        <AgentChainDialog
          workspaceId={workspaceId}
          agents={editable}
          chain={dialogChain}
          onClose={() => {
            setEditing(null);
            onCreatingDone();
          }}
          onSaved={(next) => {
            setChains(next);
            setEditing(null);
            onCreatingDone();
          }}
        />
      )}
      {removing && (
        <Dialog open onClose={() => setRemoving(null)} className="max-w-md">
          <DialogBody className="space-y-2 pt-5">
            <DialogTitle>{t("deleteTitle", { name: removing.name })}</DialogTitle>
            <p className="text-sm text-fg-muted">{t("deleteBody")}</p>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() => {
                const id = removing.id;
                act(() => removeAgentChainAction(workspaceId, id), () => setRemoving(null));
              }}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </>
  );
}

/** One chain: its name and how it stands; a click opens it, its ⋯ runs, changes or deletes it. */
function ChainRow({ chain, offline, onOpen, onRun, onRemove }: { chain: AgentChainView; offline: boolean; onOpen: () => void; onRun: () => void; onRemove: () => void }) {
  const t = useTranslations("sidebar.agentChains");
  const format = useFormatter();
  const run = chain.run;
  const going = chainRunning(run);
  const total = chain.steps.length;
  const status = (() => {
    if (run && going) return t("running", { step: run.step + 1, total });
    if (chain.repeats && !chain.enabled) return t("paused");
    if (run?.status === "failed") return t("failed", { step: run.step + 1 });
    if (run?.status === "stopped") {
      const why = WHY.find((w) => w === run.code) ?? "other";
      return t("stopped", { step: run.step + 1, why: t(`why.${why}`) });
    }
    if (chain.repeats && chain.nextRunAt) return t("next", { date: format.dateTime(new Date(chain.nextRunAt), { weekday: "short", hour: "numeric", minute: "2-digit" }) });
    if (run?.status === "done") return t("done");
    return t("steps", { count: total });
  })();
  return (
    <li className="group relative flex items-center rounded-md hover:bg-bg-hover has-[[data-open]]:bg-bg-hover">
      <button type="button" onClick={onOpen} disabled={offline} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-md py-2 ps-1.5 pe-2 text-start">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center">
          <Workflow className="h-4 w-4 text-fg-muted" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-fg">{chain.name}</span>
          <span className={cn("truncate text-xs", run?.status === "failed" && !going ? "text-danger" : "text-fg-faint")}>{status}</span>
        </span>
        {going && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />}
      </button>
      {!offline && (
        // No transform here: it would hold the menu, placed in the window, inside the scrolling list.
        <div className="absolute inset-y-0 inset-e-1 hidden items-center bg-inherit group-hover:flex has-[[data-open]]:flex focus-within:flex pointer-coarse:flex">
          <Popover
            align="end"
            trigger={({ toggle }) => (
              <IconButton label={t("actions")} onClick={toggle}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="w-56">
                <MenuItem
                  icon={<Play className="h-4 w-4" />}
                  disabled={going}
                  onClick={() => {
                    close();
                    onRun();
                  }}
                >
                  {t("runNow")}
                </MenuItem>
                <MenuItem
                  icon={<Pencil className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    onOpen();
                  }}
                >
                  {t("edit")}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  danger
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => {
                    close();
                    onRemove();
                  }}
                >
                  {t("delete")}
                </MenuItem>
              </div>
            )}
          </Popover>
        </div>
      )}
    </li>
  );
}
