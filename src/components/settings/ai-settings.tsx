"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { updateWorkspaceSettingsAction } from "@/app/actions/workspaces";
import { Switch } from "@/components/ui";
import { SettingsRow } from "./section";
import { useAction } from "./workspace-settings";

/**
 * Settings > General > AI: owners turn the workspace's AI features, the AI chat's memory, its web
 * search (where the server has a search service) and its changing things without asking on or off;
 * everyone sees which provider and models the server uses and which models the chat offers. Without a provider or an embeddings
 * model on the server there is nothing to turn on.
 */
export function AiSettings({
  workspaceId,
  enabled,
  memory,
  webSearch,
  autoChanges,
  canEdit,
  provider,
  chatModels,
  embeddings,
}: {
  workspaceId: string;
  enabled: boolean;
  /** The AI chat keeps notes about people (server/ai-memory.ts). */
  memory: boolean;
  /** The AI chat may search the web (on), or could (off); null when the server has no search service. */
  webSearch: boolean | null;
  /** The AI chat may change things without asking (its mode Auto, "don't ask again"). */
  autoChanges: boolean;
  canEdit: boolean;
  /** The server's AI provider and model; null when none is set up. */
  provider: { provider: string; model: string } | null;
  /** The models people may pick in the AI chat (server/ai-chat.ts chatModelsFor). */
  chatModels: string[];
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
      {provider && <ChatSetting anchor="aiAutoChanges" workspaceId={workspaceId} setting="aiAutoChanges" enabled={autoChanges} canEdit={canEdit && value} />}
      <SettingsRow
        title={t("provider")}
        description={provider ? t("providerValue", { provider: provider.provider, model: provider.model }) : t("noProvider")}
      />
      {provider && chatModels.length > 1 && <SettingsRow title={t("chatModels")} description={t("chatModelsValue", { models: chatModels.join(", ") })} />}
      <SettingsRow title={t("semanticSearch")} description={embeddings ? t("semanticValue", { model: embeddings }) : t("semanticOff")} />
    </>
  );
}

/**
 * A switch of the AI chat for the whole workspace, only while AI itself is on: its memory (notes stay
 * when it's off), searching the web (read-only, the server's search service), or changing things
 * without asking.
 */
const CHAT_SETTINGS = {
  aiMemory: { title: "memory", hint: "memoryHint" },
  aiWebSearch: { title: "webSearch", hint: "webSearchHint" },
  aiAutoChanges: { title: "autoChanges", hint: "autoChangesHint" },
} as const;

function ChatSetting({
  anchor,
  workspaceId,
  setting,
  enabled,
  canEdit,
}: {
  anchor?: string;
  workspaceId: string;
  setting: keyof typeof CHAT_SETTINGS;
  enabled: boolean;
  canEdit: boolean;
}) {
  const t = useTranslations("ai.settings");
  const [value, setValue] = useState(enabled);
  const { pending, error, run } = useAction();
  const title = t(CHAT_SETTINGS[setting].title);
  return (
    <SettingsRow
      anchor={anchor}
      title={title}
      description={error ? <span className="text-danger">{error}</span> : t(CHAT_SETTINGS[setting].hint)}
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
