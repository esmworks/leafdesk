import { CopyButton } from "@/components/settings/copy-button";
import { SettingsRow } from "@/components/settings/section";

/** A settings row showing an ID (a workspace's, a person's) with a copy button, for the REST API, MCP and scripts. */
export function IdRow({ title, description, value }: { title: string; description: string; value: string }) {
  return (
    <SettingsRow
      title={title}
      description={
        <>
          {description}
          <code className="mt-1 block text-xs break-all" data-id-value>
            {value}
          </code>
        </>
      }
      control={<CopyButton value={value} />}
    />
  );
}
