"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { requestAgentLimitAction } from "@/app/actions/agents";
import { read } from "@/components/read";
import { Button, cn, Input, textareaClass } from "@/components/ui";
import { MAX_LIMIT_REQUEST_NOTE, type AgentLimitRequestView } from "@/lib/agent-guardrails";
import { MAX_AGENT_TOKEN_LIMIT } from "@/lib/agents";

/** Asking the workspace's owners for a higher monthly token limit, and the request that waits. */
export function AgentLimitRequest({ workspaceId, agentId, limit }: { workspaceId: string; agentId: string; limit: number }) {
  const t = useTranslations("settings.agents.limitRequest");
  const tc = useTranslations("common");
  const format = useFormatter();
  const [pending, setPending] = useState<AgentLimitRequestView | null>(null);
  const [open, setOpen] = useState(false);
  const [tokens, setTokens] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    read("agentLimitRequest", workspaceId, agentId)
      .then((res) => live && res.ok && setPending(res.data))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId, agentId]);

  const start = () => {
    setTokens(String(pending?.tokens ?? limit * 2));
    setNote(pending?.note ?? "");
    setError(null);
    setOpen(true);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await requestAgentLimitAction(workspaceId, agentId, Number(tokens), note);
      if (res.ok) {
        setPending(res.data);
        setOpen(false);
      } else setError(res.error);
    } catch {
      setError(tc("genericError"));
    } finally {
      setBusy(false);
    }
  };

  if (open) {
    return (
      <form
        className="mb-2 rounded-md border border-border px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <p className="text-xs text-fg-muted">{t("help", { limit: format.number(limit) })}</p>
        <label className="mt-2 block text-sm" htmlFor="agent-limit-request-tokens">
          {t("tokens")}
        </label>
        <Input
          id="agent-limit-request-tokens"
          type="number"
          inputMode="numeric"
          min={limit + 1}
          max={MAX_AGENT_TOKEN_LIMIT}
          step={1}
          required
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          className="mt-1 w-48"
        />
        <label className="mt-2 block text-sm" htmlFor="agent-limit-request-note">
          {t("note")}
        </label>
        <textarea
          id="agent-limit-request-note"
          className={cn(textareaClass, "mt-1 min-h-16")}
          maxLength={MAX_LIMIT_REQUEST_NOTE}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
            {tc("cancel")}
          </Button>
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {pending ? t("update") : t("send")}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
      {pending && (
        <span className="min-w-0 flex-1">
          {t("waiting", { tokens: format.number(pending.tokens), date: format.dateTime(new Date(pending.createdAt), { dateStyle: "medium" }) })}
        </span>
      )}
      <Button size="sm" variant="ghost" onClick={start}>
        {pending ? t("change") : t("ask")}
      </Button>
    </div>
  );
}
