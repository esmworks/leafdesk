import { getTranslations } from "next-intl/server";
import { mcpResource } from "@/lib/env";
import { McpClientTabs, Snippet } from "./mcp-client-tabs";
import { SettingsGroup } from "./section";

/** How to connect Claude, Codex and other MCP clients to this Leafdesk instance. */
export async function McpInstructions() {
  const t = await getTranslations("settings.mcp");
  const url = mcpResource();

  return (
    <SettingsGroup anchor="mcp" title={t("heading")} description={t("description")}>
      <div className="space-y-2 px-5 py-4">
        <div className="text-sm font-medium">{t("serverUrl")}</div>
        <Snippet value={url} />
      </div>
      <div className="px-5 py-4">
        <McpClientTabs
          label={t("heading")}
          clients={[
            { id: "claude", title: t("claude.title"), body: t("claude.body") },
            { id: "claudeCode", title: t("claudeCode.title"), body: t("claudeCode.body"), command: `claude mcp add --transport http leafdesk ${url}` },
            { id: "codex", title: t("codex.title"), body: t("codex.body"), command: `codex mcp add leafdesk --url ${url}` },
            { id: "other", title: t("other.title"), body: t("other.body") },
          ]}
        />
      </div>
    </SettingsGroup>
  );
}
