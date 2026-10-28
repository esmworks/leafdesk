/**
 * Leafdesk's MCP tools offered to its own AI chat beside the chat's own (ai-tools.ts): database
 * views, properties, moving, copying and trashing pages, versions, dashboards, automations,
 * agents… `find_tools` names those that fit what the model needs, with their inputs, and
 * `use_tool` calls one. They run in this process through the MCP server (mcp/tools.ts), as the
 * person and with their access, with the model as the writer, held to the same checks as for any
 * MCP client. The chat asks before each that changes something (ai-chat.ts); the server is only
 * started once the model looks for one.
 */
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { ChatToolRecord } from "@/db/schema/ai";
import type { AiTool, AiToolCall } from "@/server/ai";
import { truncateText } from "@/server/ai/prompts";
import { inputSummary, resultText } from "@/server/connections/tools";
import { DOCS_PREFIX } from "@/server/mcp/docs";
import { NOTIFICATIONS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "@/server/mcp/principal";

/**
 * MCP tools the chat has its own of (search_pages, read_page, query_database, create_row…), whose
 * changes it shows in full before they're made; the person's notes, kept apart and approved
 * one by one (ai-memory.ts); and a file fetched from an address, which would carry data out.
 */
const HIDDEN: ReadonlySet<string> = new Set([
  "search",
  "get_page",
  "query_database",
  "create_page",
  "update_page",
  "create_database",
  "create_database_row",
  "create_database_rows",
  "update_database_row",
  "update_database_rows",
  "add_comment",
  "list_comments",
  "get_page_history",
  "list_memory",
  "change_memory",
  "attach_file",
]);

/**
 * Changes asked about every time, also where the person said not to ask again: they invite or
 * mail people, open things to others, or set work going later without anyone watching
 * (automations, agents, follow-up sequences).
 */
const ASKED_EACH_TIME: ReadonlySet<string> = new Set([
  "invite_member",
  "set_property_access",
  "share_agent",
  "set_agent_access",
  "set_agent_connection_tools",
  "set_agent_schedule",
  "set_agent_skill",
  "create_agent",
  "update_agent",
  "restore_agent_version",
  "start_agent_run",
  "chat_with_agent",
  "answer_pending_change",
  "create_automation",
  "update_automation",
  "publish_automation",
  "test_automation",
  "enroll_in_sequence",
  "change_enrollment",
]);

export type MoreTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
  /** Changes something (not marked read-only). */
  writes: boolean;
  /** Asked about every time it's called (ASKED_EACH_TIME). */
  eachTime: boolean;
};

export type MoreTools = {
  byName: ReadonlyMap<string, MoreTool>;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
};

/**
 * The MCP server as `userId`, connected in this process: its tools less those the chat has its own
 * of; with `writes` false only those that read, with `eachTime` false none of ASKED_EACH_TIME (for
 * agents' runs, where no one is asked).
 */
export async function openMoreTools(userId: string, { writes, eachTime = true }: { writes: boolean; eachTime?: boolean }): Promise<MoreTools> {
  // Without pages:write the server refuses every change itself, whatever the chat lets through.
  const scopes = [READ_SCOPE, NOTIFICATIONS_SCOPE, ...(writes ? [WRITE_SCOPE] : [])];
  // Loaded when first needed: the MCP server reaches the agents, which reach the chat.
  const { createMcpServer } = await import("@/server/mcp/tools");
  const server = createMcpServer({ userId, clientId: "", scopes }, { actor: { userId, model: true } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "Leafdesk AI", version: "1.0.0" });
  await client.connect(clientSide);
  const byName = new Map<string, MoreTool>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools) {
      if (HIDDEN.has(tool.name)) continue;
      const writesHere = tool.annotations?.readOnlyHint !== true;
      if (writesHere && !writes) continue;
      if (!eachTime && ASKED_EACH_TIME.has(tool.name)) continue;
      byName.set(tool.name, {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        writes: writesHere,
        eachTime: ASKED_EACH_TIME.has(tool.name),
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return {
    byName,
    async call(name, args, signal) {
      const result = (await client.callTool({ name, arguments: args }, { signal })) as CallToolResult;
      return { text: resultText(result), isError: Boolean(result.isError) };
    },
    async close() {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}

/** openMoreTools when first needed; `close` closes it if it was opened. */
export function lazyMoreTools(userId: string, options: { writes: boolean; eachTime?: boolean }) {
  let opened: Promise<MoreTools> | null = null;
  return {
    open: () => (opened ??= openMoreTools(userId, options)),
    async close() {
      const tools = opened && (await opened.catch(() => null));
      await tools?.close();
    },
  };
}

export const FIND_TOOLS: AiTool = {
  name: "find_tools",
  description:
    "Finds more Leafdesk tools, for what the other tools don't do: database views (calendar, board, timeline, gallery…) and their filters and sorts, adding, changing or deleting a database's properties and changing their type, moving, copying, archiving or trashing pages and getting them back, restoring a page's earlier version, dashboards, automations, agents, sub-items and dependencies, templates, daily notes, members and teamspaces, notifications. Look here before saying you can't do something. Returns the tools that fit, with what each takes; call one with use_tool. Without a query, lists them all by name.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "What you need to do, in a few English words (e.g. \"calendar view\", \"add property\", \"move page\")." } },
  },
};

export const USE_TOOL: AiTool = {
  name: "use_tool",
  description:
    "Calls a Leafdesk tool find_tools named, with its inputs as find_tools showed them. Ids may be Leafdesk links. Inputs pointing at leafdesk://docs/<topic> are explained there: read it with read_page (page_id \"leafdesk://docs/<topic>\").",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The tool's name, as find_tools gave it." },
      arguments: { type: "object", description: "The tool's inputs.", additionalProperties: true },
    },
    required: ["name", "arguments"],
  },
};

export const MORE_TOOL_NAMES: ReadonlySet<string> = new Set([FIND_TOOLS.name, USE_TOOL.name]);

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** How well a tool fits the query's words: its name counts most, then its title, then what it says it does. */
function fit(tool: MoreTool, query: string[]): number {
  const name = new Set(words(tool.name));
  const title = new Set(words(tool.title));
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

/** find_tools' answer: the tools that fit `query` best, each with its inputs, within `room` characters. */
export function findTools(tools: MoreTools, query: string, room: number): string {
  const all = [...tools.byName.values()];
  const asked = words(query);
  const found = asked.length
    ? all
        .map((tool) => ({ tool, score: fit(tool, asked) }))
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((t) => t.tool)
    : [];
  const names = `All of them: ${all.map((t) => t.name).join(", ")}.`;
  if (!found.length) return `${asked.length ? "No tool fits those words. " : ""}${names} Ask again with words from a name to see what it takes.`;
  const blocks: string[] = [];
  let left = room - names.length - 200;
  for (const tool of found) {
    const block = [
      `## ${tool.name} (${tool.title}${tool.writes ? ", changes something" : ", only reads"})`,
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

/** The tool use_tool names and its inputs, or what to tell the model when there's no such tool here. */
export function pickMoreTool(tools: MoreTools, call: AiToolCall, why = ""): { tool: MoreTool; args: Record<string, unknown> } | { content: string; isError: true } {
  const name = typeof call.arguments.name === "string" ? call.arguments.name.trim() : "";
  const tool = tools.byName.get(name);
  if (!tool) return { content: `There is no tool "${name.slice(0, 100)}" here${why}. find_tools names those there are.`, isError: true };
  const given = call.arguments.arguments;
  return { tool, args: given && typeof given === "object" && !Array.isArray(given) ? (given as Record<string, unknown>) : {} };
}

export const moreToolStep = (tool: MoreTool, args: Record<string, unknown>, outcome: ChatToolRecord["outcome"]): ChatToolRecord => ({
  kind: "leafdesk",
  tool: tool.name,
  title: tool.title,
  writes: tool.writes,
  input: inputSummary(args),
  outcome,
});

/** Calls one, its answer cut to `room`; throws only when `signal` stopped it. */
export async function callMoreTool(
  tools: MoreTools,
  { tool, args }: { tool: MoreTool; args: Record<string, unknown> },
  room: number,
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean; step: ChatToolRecord }> {
  try {
    const out = await tools.call(tool.name, args, signal);
    return { content: truncateText(out.text, Math.max(200, room)), isError: out.isError, step: moreToolStep(tool, args, out.isError ? "failed" : "done") };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error(`[ai] ${tool.name} failed`, error);
    return { content: `${tool.name} failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}`, isError: true, step: moreToolStep(tool, args, "failed") };
  }
}

/** Whether read_page is asked for a docs topic (leafdesk://docs/<topic>) rather than a page. */
export const isDocsAddress = (id: unknown): id is string => typeof id === "string" && id.trim().startsWith(DOCS_PREFIX);

/** A docs topic the tools' inputs point at, as read_page returns it, cut to `room`; null when there's no such topic. */
export async function readDocsTopic(id: string, room: number): Promise<string | null> {
  const { readDocs } = await import("@/server/mcp/tools");
  const doc = readDocs(id);
  return doc ? truncateText(`# ${doc.title} (${doc.uri})\n\n${doc.text}`, Math.max(200, room)) : null;
}
