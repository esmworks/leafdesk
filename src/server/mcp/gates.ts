import type { CallToolResult, ScopeChallengeHandler } from "@modelcontextprotocol/server";
import * as z from "zod";
import { CORE_TOOLS, findTools, GATE_TOOLS, toolCategory, type CatalogTool } from "./catalog";
import { errorResult } from "./format";

/**
 * The tools an app's list leaves out (catalog.ts) and the three that reach them: find_tools says
 * what they are and take, run_read_tool calls one that only reads and run_write_tool one that
 * changes something, so an app that asks before changes still asks. A call runs the tool's own
 * handler with its own input check and its own scope challenge: the same checks as when it is
 * listed. Each search and call is logged (`[mcp] catalog`), to see whether the tools are found.
 */

type StandardInput = { "~standard": z.ZodObject["~standard"] };

/** A tool kept out of the list, as tools.ts registered it (handler already wrapped). */
export type HeldTool = {
  name: string;
  title: string;
  description: string;
  writes: boolean;
  input: StandardInput | null;
  scopeChallenge?: ScopeChallengeHandler;
  handler: (args: unknown, extra: unknown) => unknown;
};

/** Characters find_tools fills with the tools that fit. */
const FIND_ROOM = 24_000;

type Register = (name: string, config: unknown, handler: (args: never, extra: unknown) => unknown) => unknown;

/** A tool's input as JSON Schema, as the tool list would show it (without `$schema`). */
function jsonInput(input: StandardInput | null): unknown {
  if (!input) return { type: "object" };
  const standard = input["~standard"] as { jsonSchema?: { input: (options: { target: string }) => Record<string, unknown> } };
  if (!standard.jsonSchema) return { type: "object" };
  const { $schema: _, ...schema } = standard.jsonSchema.input({ target: "draft-2020-12" });
  return schema;
}

const issueText = (issues: readonly { message: string; path?: readonly unknown[] }[]) =>
  issues
    .slice(0, 10)
    .map((issue) => {
      const path = (issue.path ?? []).map((p) => (typeof p === "object" && p && "key" in p ? String(p.key) : String(p))).join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");

const READ = { readOnlyHint: true, openWorldHint: false } as const;

/** Registers find_tools, run_read_tool and run_write_tool for the `held` tools. */
export function registerGates(register: Register, held: ReadonlyMap<string, HeldTool>) {
  let described: Map<string, CatalogTool> | null = null;
  const catalog = () =>
    (described ??= new Map(
      [...held.values()].map((tool) => [
        tool.name,
        { name: tool.name, title: tool.title, description: tool.description, inputSchema: jsonInput(tool.input), writes: tool.writes, category: toolCategory(tool.name) },
      ]),
    ));

  register(
    GATE_TOOLS.find,
    {
      title: "Find more Leafdesk tools",
      description: `Finds Leafdesk tools that aren't in your list: database views (table, board, calendar, timeline, gallery, chart…) and their filters and sorts; adding, changing or deleting a database's properties and changing their type; property access, sub-items and dependencies; moving, copying, archiving or trashing pages and getting them back; page history and versions; daily notes, meeting notes, templates and snippets; dashboards; automations; agents, their runs, schedules and memory, and changes they proposed; follow-up sequences; members and groups; PDF templates. Look here before saying you can't do something. Returns the tools that fit, with what each takes; call one that only reads with ${GATE_TOOLS.read} and one that changes something with ${GATE_TOOLS.write}. Without a query, lists them all by category.`,
      inputSchema: z.object({
        query: z.string().max(200).default("").describe('What you need to do, in a few English words ("calendar view", "add property", "move page"), or a tool\'s name.'),
      }),
      annotations: READ,
    },
    ({ query }: { query: string }): CallToolResult => {
      const tools = catalog();
      const text = findTools({ byName: tools }, query, FIND_ROOM, GATE_TOOLS);
      console.info("[mcp] catalog", JSON.stringify({ find: query, fits: text.startsWith("## ") ? text.match(/^## (\w+)/gm)?.map((m) => m.slice(3)) : [] }));
      return { content: [{ type: "text", text }] };
    },
  );

  const gate = (writes: boolean) => {
    const name = writes ? GATE_TOOLS.write : GATE_TOOLS.read;
    const scopeChallenge: ScopeChallengeHandler = (context) => {
      const args = (context.request.params as { arguments?: { name?: unknown } } | undefined)?.arguments;
      const tool = typeof args?.name === "string" ? held.get(args.name) : undefined;
      // A writing tool called through the read gate is refused below, not asked a wider scope for.
      return tool && (writes || !tool.writes) ? tool.scopeChallenge?.(context) : undefined;
    };
    register(
      name,
      {
        title: writes ? "Run a Leafdesk tool that changes something" : "Run a Leafdesk tool that only reads",
        description: writes
          ? `Calls a Leafdesk tool find_tools named that changes something (or one that only reads), with its inputs as find_tools showed them. The tool runs with the user's access and its own checks; what it changes is recorded as your app's. Ids may be Leafdesk links. Inputs pointing at leafdesk://docs/<topic> are explained there (get_page with that address as page_id).`
          : `Calls a Leafdesk tool find_tools named that only reads, with its inputs as find_tools showed them; one that changes something is refused here (use ${GATE_TOOLS.write}). Ids may be Leafdesk links.`,
        inputSchema: z.object({
          name: z.string().min(1).max(100).describe("The tool's name, as find_tools gave it."),
          arguments: z.record(z.string(), z.unknown()).default({}).describe("The tool's inputs."),
        }),
        annotations: writes ? { readOnlyHint: false, destructiveHint: true, openWorldHint: false } : READ,
        scopeChallenge,
      },
      async ({ name: toolName, arguments: args }: { name: string; arguments: Record<string, unknown> }, extra: unknown) => {
        const tool = held.get(toolName);
        if (!tool) {
          return errorResult(
            CORE_TOOLS.has(toolName)
              ? `${toolName} is in your tool list: call it directly.`
              : `There is no tool "${toolName.slice(0, 100)}" here. find_tools names those there are.`,
          );
        }
        if (tool.writes && !writes) return errorResult(`${toolName} changes something: call it with ${GATE_TOOLS.write}.`);
        let value: unknown = args;
        if (tool.input) {
          const checked = await tool.input["~standard"].validate(args);
          if (checked.issues) return errorResult(`Invalid arguments for ${toolName}: ${issueText(checked.issues)}`);
          value = checked.value;
        }
        console.info("[mcp] catalog", JSON.stringify({ run: toolName }));
        return tool.handler(value, extra);
      },
    );
  };
  gate(false);
  gate(true);
}
