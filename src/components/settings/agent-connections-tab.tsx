"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { listAgentGrantsAction, listConnectionsAction, setAgentGrantAction } from "@/app/actions/connections";
import { cn } from "@/components/ui";
import type { AgentView } from "@/lib/agents";
import type { AgentGrantView, ConnectionView } from "@/lib/connections";
import { ConnectionIcon, ToolKindLabel } from "./connections-panel";

/**
 * The tools of each connection an agent may use. Ticking a tool allows it at once; tools that
 * change something still wait for an owner's approval each time the agent calls them.
 */
export function AgentConnectionsTab({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.connections");
  const tc = useTranslations("common");
  const [connections, setConnections] = useState<ConnectionView[] | null>(null);
  const [grants, setGrants] = useState<AgentGrantView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([listConnectionsAction(workspaceId), listAgentGrantsAction(workspaceId, agent.id)])
      .then(([conns, given]) => {
        if (!live) return;
        if (!conns.ok) return setError(conns.error);
        if (!given.ok) return setError(given.error);
        setConnections(conns.data);
        setGrants(given.data);
      })
      .catch(() => live && setError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc]);

  const allowed = (connectionId: string) => new Set(grants.find((g) => g.connectionId === connectionId)?.tools ?? []);

  const save = async (connectionId: string, tools: string[]) => {
    setSaving(connectionId);
    setError(null);
    const before = grants;
    // Shown at once; put back if it didn't save.
    setGrants((list) => [...list.filter((g) => g.connectionId !== connectionId), ...(tools.length ? [{ connectionId, tools }] : [])]);
    try {
      const res = await setAgentGrantAction(workspaceId, agent.id, connectionId, tools);
      if (res.ok) setGrants(res.data);
      else {
        setGrants(before);
        setError(res.error);
      }
    } catch {
      setGrants(before);
      setError(tc("genericError"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4">
      <p className="text-sm text-fg-muted">{t("description")}</p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!connections ? (
        !error && <p className="text-sm text-fg-muted">{tc("loading")}</p>
      ) : connections.length === 0 ? (
        <p className="text-sm text-fg-muted">
          {t.rich("empty", {
            link: (chunks) => (
              <Link href={`/w/${workspaceId}/settings?tab=connections`} className="text-fg underline underline-offset-2 hover:text-accent">
                {chunks}
              </Link>
            ),
          })}
        </p>
      ) : (
        connections.map((conn) => {
          const chosen = allowed(conn.id);
          const toggle = (tool: string, on: boolean) => {
            const next = new Set(chosen);
            if (on) next.add(tool);
            else next.delete(tool);
            void save(conn.id, [...next]);
          };
          return (
            <section key={conn.id} className="rounded-lg border border-border">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <ConnectionIcon icon={conn.icon} />
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{conn.name}</h3>
                <span className="shrink-0 text-xs text-fg-muted">{t("allowedCount", { n: chosen.size, total: conn.tools.length })}</span>
              </div>
              {conn.status !== "ready" && <p className="px-3 pt-2 text-xs text-fg-muted">{t("notReady")}</p>}
              {conn.tools.length === 0 ? (
                <p className="px-3 py-2 text-xs text-fg-muted">{t("noTools")}</p>
              ) : (
                <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                  {conn.tools.map((tool) => {
                    const id = `grant-${conn.id}-${tool.name}`;
                    return (
                      <li key={tool.name} className="flex items-start gap-2.5 px-3 py-2">
                        <input
                          id={id}
                          type="checkbox"
                          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                          checked={chosen.has(tool.name)}
                          disabled={saving === conn.id}
                          onChange={(e) => toggle(tool.name, e.target.checked)}
                        />
                        <label htmlFor={id} className={cn("min-w-0 flex-1", saving === conn.id && "opacity-60")}>
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-sm">{tool.title || tool.name}</span>
                            <ToolKindLabel kind={tool.kind} />
                          </span>
                          {tool.description && <span className="line-clamp-2 block text-xs text-fg-muted">{tool.description}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}
