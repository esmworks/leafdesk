import { getTranslations } from "next-intl/server";
import { mcpResource } from "@/lib/env";
import { CopyButton } from "./copy-button";
import { SettingsGroup, SettingsRow } from "./section";

function Snippet({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg py-1.5 pe-1.5 ps-3">
      <code className="min-w-0 flex-1 text-xs break-all">{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

/** How to connect Claude, Codex and other MCP clients to this Leafdesk instance. */
export async function McpInstructions() {
  const t = await getTranslations("settings.mcp");
  const url = mcpResource();
  const claudeCode = `claude mcp add --transport http leafdesk ${url}`;
  const codex = `codex mcp add leafdesk --url ${url}`;

  return (
    <SettingsGroup title={t("heading")} description={t("description")}>
      <SettingsRow title={t("serverUrl")}>
        <Snippet value={url} />
      </SettingsRow>
      <SettingsRow title={t("claude.title")} description={t("claude.body")} />
      <SettingsRow title={t("claudeCode.title")} description={t("claudeCode.body")}>
        <Snippet value={claudeCode} />
      </SettingsRow>
      <SettingsRow title={t("codex.title")} description={t("codex.body")}>
        <Snippet value={codex} />
      </SettingsRow>
      <SettingsRow title={t("other.title")} description={t("other.body")} />
    </SettingsGroup>
  );
}
