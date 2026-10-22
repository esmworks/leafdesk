"use client";

import { ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { addAgentSkillAction, listAgentSkillsAction, removeAgentSkillAction } from "@/app/actions/agents";
import { listSkillsAction } from "@/app/actions/skills";
import { useAction } from "@/components/settings/workspace-settings";
import { Button, cn, IconButton, PageIcon, pageLabel } from "@/components/ui";
import { editsAgent, MAX_AGENT_SKILLS, type AgentSkillView, type AgentView } from "@/lib/agents";
import { PagePicker, type PickablePage } from "./agent-page-picker";

/**
 * The skills an agent follows on every run, after its own instructions, and giving it one. Only
 * skills no one but the workspace's owners may edit can be given; a run leaves out one that others
 * may edit by then, so each shows whether runs follow it now.
 */
export function AgentSkillsTab({ workspaceId, agent }: { workspaceId: string; agent: AgentView }) {
  const t = useTranslations("settings.agents.skills");
  const tc = useTranslations("common");
  const [given, setGiven] = useState<{ skills: AgentSkillView[]; hidden: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [library, setLibrary] = useState<PickablePage[] | null>(null);
  const { pending, error, run } = useAction();

  useEffect(() => {
    let live = true;
    listAgentSkillsAction(workspaceId, agent.id)
      .then((res) => {
        if (!live) return;
        if (res.ok) setGiven(res.data);
        else setLoadError(res.error);
      })
      .catch(() => live && setLoadError(tc("genericError")));
    return () => {
      live = false;
    };
  }, [workspaceId, agent.id, tc]);

  useEffect(() => {
    if (!adding || library) return;
    let live = true;
    listSkillsAction(workspaceId)
      .then((res) => {
        if (!live) return;
        setLibrary(res.ok ? res.data.map((s) => ({ id: s.id, title: s.title, icon: s.icon, kind: "page" as const, place: s.description })) : []);
      })
      .catch(() => live && setLibrary([]));
    return () => {
      live = false;
    };
  }, [adding, library, workspaceId]);

  const taken = new Set(given?.skills.map((s) => s.pageId));
  const candidates = library && library.filter((s) => !taken.has(s.id));
  const full = (given?.skills.length ?? 0) + (given?.hidden ?? 0) >= MAX_AGENT_SKILLS;

  return (
    <div className={cn("max-h-[65vh] space-y-4 overflow-y-auto px-5 py-4", pending && "opacity-70")}>
      <p className="text-sm text-fg-muted">{t("description")}</p>
      <p className="flex gap-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
        <span>{t("rule")}</span>
      </p>
      {agent.archived && <p className="text-sm text-fg-muted">{t("archived")}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {!given ? (
        <p className="text-sm text-fg-muted" role={loadError ? "alert" : undefined}>
          {loadError ?? tc("loading")}
        </p>
      ) : (
        <>
          {given.skills.length ? (
            <ol aria-label={t("list")} className="divide-y divide-border rounded-md border border-border">
              {given.skills.map((s) => {
                const title = pageLabel(s.title, tc("untitled"));
                const skipped = s.status !== "usable";
                return (
                  <li key={s.pageId} className="flex items-start gap-2 px-3 py-2 text-sm">
                    <PageIcon icon={s.icon} kind="page" className="mt-0.5 text-sm" />
                    <div className="min-w-0 flex-1">
                      <Link href={`/w/${workspaceId}/p/${s.pageId}`} className="block truncate hover:underline">
                        {title}
                      </Link>
                      <span className={cn("block text-xs", skipped ? "text-danger" : "text-fg-muted")}>{t(`status.${s.status}`)}</span>
                    </div>
                    {editsAgent(agent) && (
                      <IconButton
                        label={t("remove", { title })}
                        disabled={pending}
                        onClick={() => run(() => removeAgentSkillAction(workspaceId, agent.id, s.pageId), setGiven)}
                        className="hover:text-danger"
                      >
                        <X className="h-4 w-4" />
                      </IconButton>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-fg-muted">{t("empty")}</p>
          )}
          {given.hidden > 0 && <p className="text-xs text-fg-muted">{t("hidden", { count: given.hidden })}</p>}
          {!agent.archived &&
            editsAgent(agent) &&
            (full ? (
              <p className="text-xs text-fg-muted">{t("full", { max: MAX_AGENT_SKILLS })}</p>
            ) : adding ? (
              <section className="space-y-2 border-t border-border pt-4">
                <h3 className="text-sm font-medium">{t("add")}</h3>
                <PagePicker
                  autoFocus
                  pages={candidates}
                  label={t("search")}
                  empty={t("noSkills")}
                  onPick={(skill) =>
                    run(() => addAgentSkillAction(workspaceId, agent.id, skill.id), (next) => {
                      setGiven(next);
                      setAdding(false);
                    })
                  }
                />
                <p className="text-xs text-fg-faint">
                  {t.rich("libraryNote", {
                    link: (chunks) => (
                      <Link href={`/w/${workspaceId}/skills`} className="underline hover:text-fg">
                        {chunks}
                      </Link>
                    ),
                  })}
                </p>
              </section>
            ) : (
              <Button onClick={() => setAdding(true)}>{t("add")}</Button>
            ))}
        </>
      )}
    </div>
  );
}
