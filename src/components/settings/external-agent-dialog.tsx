"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { createExternalAgentAction } from "@/app/actions/external-agents";
import { read } from "@/components/read";
import { IconPicker } from "@/components/page/icon-picker";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader, Input, selectClass } from "@/components/ui";
import { MAX_AGENT_DESCRIPTION, MAX_AGENT_NAME, type AgentView } from "@/lib/agents";
import { useAction } from "./workspace-settings";
import { AgentIcon } from "./agent-dialog";

/** A secret shown once, with a button that copies it. */
export function SecretBox({ secret }: { secret: string }) {
  const t = useTranslations("settings.agents.external");
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-bg-subtle px-3 py-2 text-xs whitespace-nowrap">{secret}</code>
      <Button
        onClick={() => {
          void navigator.clipboard?.writeText(secret).then(() => setCopied(true));
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

/** The person's connected apps, null while they load. */
export function useOwnApps() {
  const [apps, setApps] = useState<{ clientId: string; name: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    read("ownConnectedApps")
      .then((res) => live && setApps(res.ok ? res.data : []))
      .catch(() => live && setApps([]));
    return () => {
      live = false;
    };
  }, []);
  return apps;
}

/**
 * New external agent: an outside agent (Claude Code, Cursor, any MCP client) that works on what is
 * assigned to it. Name and icon like any agent, then how it is reached: one of the person's connected
 * apps, or a token of its own, shown once. Loaded when it first opens (a lazyPart).
 */
export function ExternalAgentDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (agent: AgentView) => void;
}) {
  const t = useTranslations("settings.agents.external");
  const tf = useTranslations("settings.agents.form");
  const tc = useTranslations("common");
  const apps = useOwnApps();
  const [icon, setIcon] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"app" | "token">("app");
  const [clientId, setClientId] = useState("");
  const [made, setMade] = useState<{ agent: AgentView; secret: string } | null>(null);
  const { pending, error, run } = useAction();

  const app = clientId || apps?.[0]?.clientId || "";
  const ready = name.trim() !== "" && (kind === "token" || app !== "");

  const submit = () =>
    run(
      () => createExternalAgentAction(workspaceId, { name: name.trim(), icon, description: description.trim(), via: kind === "app" ? { kind: "app", clientId: app } : { kind: "token" } }),
      ({ agent, secret }) => {
        if (secret) setMade({ agent, secret });
        else onCreated(agent);
      },
    );

  if (made) {
    return (
      <Dialog open onClose={() => onCreated(made.agent)} className="max-w-lg">
        <DialogHeader title={t("tokenTitle")} onClose={() => onCreated(made.agent)} closeLabel={tc("close")} />
        <DialogBody className="space-y-3">
          <p className="text-sm text-fg-muted">{t("tokenHelp")}</p>
          <SecretBox secret={made.secret} />
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={() => onCreated(made.agent)}>
            {t("done")}
          </Button>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} className="max-w-lg">
      <DialogHeader title={t("dialogTitle")} onClose={onClose} closeLabel={tc("close")} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) submit();
        }}
      >
        <DialogBody>
          <fieldset disabled={pending} className="space-y-4">
            <p className="text-sm text-fg-muted">{t("dialogHelp")}</p>
            <div className="flex items-end gap-2">
              <IconPicker icon={icon} onChange={setIcon}>
                {(toggle) => (
                  <button type="button" onClick={toggle} aria-label={tf("chooseIcon")} title={tf("chooseIcon")} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-lg hover:bg-bg-hover">
                    <AgentIcon icon={icon} />
                  </button>
                )}
              </IconPicker>
              <label className="block min-w-0 flex-1">
                <span className="mb-1 block text-xs font-medium text-fg-muted">{tf("name")}</span>
                <Input autoFocus value={name} maxLength={MAX_AGENT_NAME} onChange={(e) => setName(e.target.value)} />
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-fg-muted">{tf("description")}</span>
              <Input value={description} maxLength={MAX_AGENT_DESCRIPTION} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-fg-muted">{t("viaLabel")}</span>
              <select className={selectClass} value={kind} onChange={(e) => setKind(e.target.value === "token" ? "token" : "app")}>
                <option value="app">{t("viaApp")}</option>
                <option value="token">{t("viaToken")}</option>
              </select>
            </label>
            {kind === "app" &&
              (apps && apps.length === 0 ? (
                <p className="text-[13px] text-fg-muted">{t("noApps")}</p>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-fg-muted">{t("appLabel")}</span>
                  <select className={selectClass} value={app} onChange={(e) => setClientId(e.target.value)}>
                    {(apps ?? []).map((a) => (
                      <option key={a.clientId} value={a.clientId}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
          </fieldset>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || pending}>
            {t("create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
