/**
 * Which MCP tools an app's list shows and how the others are found. Every tool's definition goes
 * to the model at the start of each conversation, so most apps get the core tools below in full
 * and reach the rest through find_tools and run_read_tool / run_write_tool (tools.ts). Apps that
 * load tool definitions only when they need one (Claude Code) get them all (tool-lists.ts).
 * Leafdesk's own AI chat searches its more tools here too (ai-more-tools.ts). Pure: no imports.
 */

/** What the list shows besides the gates; every other tool is in the catalog. */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "list_workspaces",
  "list_teamspaces",
  "search",
  "list_pages",
  "list_recent_pages",
  "get_page",
  "create_page",
  "update_page",
  "get_file",
  "attach_file",
  "get_database",
  "query_database",
  // In the list itself: apps draw a tool's view only from the list's own definitions (app-view.ts).
  "show_database",
  "create_database",
  "create_database_row",
  "create_database_rows",
  "update_database_row",
  "update_database_rows",
  "list_comments",
  "add_comment",
  "list_notifications",
  "list_memory",
  "change_memory",
  "list_skills",
  "get_skill",
]);

/** The tools that find and call the catalog's, in the list instead of them. */
export const GATE_TOOLS = { find: "find_tools", read: "run_read_tool", write: "run_write_tool" } as const;

/** What a catalog tool is about, so find_tools can say it and a model can ask by it. */
const CATEGORIES: Record<string, readonly string[]> = {
  pages: [
    "watch_page",
    "get_or_create_daily_note",
    "list_daily_notes",
    "list_meeting_notes",
    "list_templates",
    "list_snippets",
    "move_page",
    "duplicate_page",
    "archive_page",
    "set_page_archived",
    "list_trash",
    "restore_page",
    "get_page_history",
    "restore_page_version",
    "set_skill",
    "change_comment",
    "check_workspace",
  ],
  pdf: ["get_pdf_template", "set_pdf_template"],
  databases: [
    "add_database_property",
    "update_database_property",
    "change_database_property_type",
    "delete_database_property",
    "set_property_access",
    "set_sub_items",
    "set_dependencies",
    "merge_rows",
    "list_row_activity",
  ],
  views: ["create_database_view", "update_database_view"],
  dashboards: ["add_dashboard", "update_dashboard_widget"],
  automations: [
    "list_automations",
    "create_automation",
    "update_automation",
    "publish_automation",
    "discard_automation_draft",
    "test_automation",
    "delete_automation",
    "list_automation_runs",
  ],
  agents: [
    "list_agents",
    "get_agent",
    "draft_agent",
    "create_agent",
    "update_agent",
    "set_agent_archived",
    "share_agent",
    "set_agent_access",
    "set_agent_skill",
    "set_agent_schedule",
    "set_agent_connection_tools",
    "change_agent_memory",
    "list_agent_runs",
    "list_agent_versions",
    "restore_agent_version",
    "start_agent_run",
    "chat_with_agent",
    "get_agent_chat",
    "list_pending_changes",
    "answer_pending_change",
    "list_connections",
  ],
  sequences: ["list_sequences", "enroll_in_sequence", "change_enrollment", "list_enrollments"],
  people: ["list_users", "list_groups", "invite_member"],
  messages: ["list_channels", "read_channel_messages", "search_messages", "send_channel_message"],
};

const CATEGORY_OF = new Map(Object.entries(CATEGORIES).flatMap(([category, names]) => names.map((name) => [name, category] as const)));

/** A catalog tool's category; "other" for one not sorted yet (tools.test.ts lists those). */
export const toolCategory = (name: string): string => CATEGORY_OF.get(name) ?? "other";

/** A tool as find_tools describes it. */
export type CatalogTool = {
  name: string;
  title: string;
  description: string;
  /** Its input as JSON Schema. */
  inputSchema: unknown;
  /** Changes something (not marked read-only). */
  writes: boolean;
  category?: string;
};

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** How well a tool fits the query's words: its name counts most, then its category and title, then what it says it does. */
function fit(tool: CatalogTool, query: string[]): number {
  const name = new Set(words(tool.name));
  const title = new Set([...words(tool.title), ...words(tool.category ?? "")]);
  const description = new Set(words(tool.description));
  let score = 0;
  for (const word of query) {
    // "views" finds "view", "properties" finds "property".
    const forms = [word, word.replace(/ies$/, "y"), word.replace(/es$/, ""), word.replace(/s$/, "")];
    if (forms.some((f) => name.has(f))) score += 3;
    else if (forms.some((f) => title.has(f))) score += 2;
    else if (forms.some((f) => description.has(f))) score += 1;
  }
  return score;
}

/** The names of the tools that fit `query`, best first, at most `limit`. */
export function toolsFitting(tools: Iterable<CatalogTool>, query: string, limit = 5): CatalogTool[] {
  const asked = words(query);
  if (!asked.length) return [];
  return [...tools]
    .map((tool) => ({ tool, score: fit(tool, asked) }))
    .filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((t) => t.tool);
}

/**
 * find_tools' answer: the tools that fit `query` best, each with its inputs, within `room`
 * characters, then every tool's name (by category where they have one). `call` names what calls
 * them: one tool for all, or one for those that read and one for those that change something.
 */
export function findTools(
  tools: { byName: ReadonlyMap<string, CatalogTool> },
  query: string,
  room: number,
  call: { read: string; write: string } = { read: "use_tool", write: "use_tool" },
): string {
  const all = [...tools.byName.values()];
  const found = toolsFitting(all, query);
  const byCategory = new Map<string, string[]>();
  for (const tool of all) {
    const key = tool.category ?? "";
    byCategory.set(key, [...(byCategory.get(key) ?? []), tool.name]);
  }
  const names = byCategory.has("")
    ? `All of them: ${all.map((t) => t.name).join(", ")}.`
    : `All of them, by category: ${[...byCategory].map(([category, list]) => `${category}: ${list.join(", ")}`).join("; ")}.`;
  if (!found.length) return `${words(query).length ? "No tool fits those words. " : ""}${names} Ask again with words from a name to see what it takes.`;
  const blocks: string[] = [];
  let left = room - names.length - 200;
  for (const tool of found) {
    const does = tool.writes ? "changes something" : "only reads";
    // Named only where reading and changing go through different tools.
    const how = call.read === call.write ? does : `${does}: call it with ${tool.writes ? call.write : call.read}`;
    const block = [
      `## ${tool.name} (${[tool.title, tool.category, how].filter(Boolean).join(", ")})`,
      tool.description,
      `Inputs (JSON schema): ${JSON.stringify(tool.inputSchema)}`,
    ].join("\n");
    if (block.length > left) {
      // One that doesn't fit is named, to be asked for alone.
      blocks.push(`## ${tool.name}: too long to show with the others; ask for it by its name.`);
      continue;
    }
    blocks.push(block);
    left -= block.length;
  }
  return `${blocks.join("\n\n")}\n\n${names}`;
}

/** Which tools an app's list shows: every one, or the core ones and the gates to the rest. */
export type ToolList = "all" | "core";
