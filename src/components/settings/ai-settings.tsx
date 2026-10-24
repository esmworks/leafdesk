"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Switch } from "@/components/ui";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > General > AI: owners turn the workspace's AI features, the AI chat's memory and its web
 * search (where the server has a search service) on or off; everyone sees which provider and models
 * the server uses. Without a provider or an embeddings
 * model on the server there is nothing to turn on.
 */
export function AiSettings({
  workspaceId,
  enabled,
  memory,
  webSearch,
  canEdit,
  provider,
  embeddings,
}: {
  workspaceId: string;
  enabled: boolean;
  /** The AI chat keeps notes about people (server/ai-memory.ts). */
  memory: boolean;
  /** The AI chat may search the web (on), or could (off); null when the server has no search service. */
  webSearch: boolean | null;
  canEdit: boolean;
  /** The server's AI provider and model; null when none is set up. */
  provider: { provider: string; model: string } | null;
  /** The server's embeddings model (semantic search); null when none is set up. */
  embeddings: string | null;
}) {
  const t = useTranslations("ai.settings");
  const [value, setValue] = useState(enabled);
  const { pending, error, run } = useAction();

  if (!provider && !embeddings) {
    return <SettingsRow title={t("enabled")} description={t("notConfigured")} />;
  }
  return (
    <>
      <SettingsRow
        title={t("enabled")}
        description={
          error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <>
              {t("enabledHint")}
              {!canEdit && <> {t("ownersOnly")}</>}
            </>
          )
        }
        control={
          <Switch
            checked={value}
            label={t("enabled")}
            disabled={!canEdit || pending}
            onChange={(next) => {
              setValue(next);
              run(async () => {
                const result = await updateWorkspaceSettingsAction(workspaceId, { ai: next });
                if (!result.ok) setValue(!next);
                return result;
              });
            }}
          />
        }
      />
      {provider && <ChatSetting workspaceId={workspaceId} setting="aiMemory" enabled={memory} canEdit={canEdit && value} />}
      {provider && webSearch !== null && <ChatSetting workspaceId={workspaceId} setting="aiWebSearch" enabled={webSearch} canEdit={canEdit && value} />}
      <SettingsRow
        title={t("provider")}
        description={provider ? t("providerValue", { provider: provider.provider, model: provider.model }) : t("noProvider")}
      />
      <SettingsRow title={t("semanticSearch")} description={embeddings ? t("semanticValue", { model: embeddings }) : t("semanticOff")} />
    </>
  );
}

/**
 * A switch of the AI chat for the whole workspace, only while AI itself is on: its memory (notes stay
 * when it's off), or searching the web (read-only, the server's search service).
 */
function ChatSetting({ workspaceId, setting, enabled, canEdit }: { workspaceId: string; setting: "aiMemory" | "aiWebSearch"; enabled: boolean; canEdit: boolean }) {
  const t = useTranslations("ai.settings");
  const [value, setValue] = useState(enabled);
  const { pending, error, run } = useAction();
  const title = setting === "aiMemory" ? t("memory") : t("webSearch");
  return (
    <SettingsRow
      title={title}
      description={error ? <span className="text-danger">{error}</span> : setting === "aiMemory" ? t("memoryHint") : t("webSearchHint")}
      control={
        <Switch
          checked={value}
          label={title}
          disabled={!canEdit || pending}
          onChange={(next) => {
            setValue(next);
            run(async () => {
              const result = await updateWorkspaceSettingsAction(workspaceId, { [setting]: next });
              if (!result.ok) setValue(!next);
              return result;
            });
          }}
        />
      }
    />
  );
}
