import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { DOC_TOPICS, docUri } from "./docs";
import { CORE_TOOLS, GATE_TOOLS, toolCategory, type ToolList } from "./catalog";
import { createMcpServer } from "./tools";
import { DATABASE_VIEW_URI } from "@/lib/mcp-view";

// Most apps send every listed tool's schema to the model on every session, so the core list
// (catalog.ts) has a budget; the rest is reached through find_tools. Raise a number only on
// purpose, in the same commit, and say why in the CHANGELOG. What a model needs only now and then
// goes into the docs topics (docs.ts), which cost nothing until read. Every tool, listed or found,
// keeps the per-tool budget: find_tools shows its schema too.
vi.mock("@/db", () => ({ db: {} }));

const MAX_TOOLS = 30;
const MAX_TOTAL_BYTES = 48_000;
const MAX_TOOL_BYTES = 12_000;
/** Some apps keep only this much of the instructions (Claude Code). */
const KEPT_INSTRUCTIONS = 2048;

type Tool = { name: string; description?: string; inputSchema?: unknown };
type Response = { result?: Record<string, unknown>; error?: { message: string } };

/** Sends `requests` (method and params) to a fresh server after initializing, and returns their responses in order. */
async function session(requests: { method: string; params: Record<string, unknown> }[], tools: ToolList = "core"): Promise<Response[]> {
  const server = createMcpServer({ userId: "user-1", clientId: "client-1", scopes: ["*"] } as never, { tools });
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  client.onmessage = (message) => void inbox.push(message);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((message) => "id" in message && message.id === id);
      if (hit) return hit as Response;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no response to request ${id}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tools-context", version: "1" } },
  });
  const initialized = await waitFor(1);
  instructions = String(initialized.result?.instructions ?? "");
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const responses: Response[] = [];
  for (const [i, request] of requests.entries()) {
    await client.send({ jsonrpc: "2.0", id: i + 2, ...request });
    responses.push(await waitFor(i + 2));
  }
  await server.close();
  return responses;
}

/** The instructions the last session's server gave. */
let instructions = "";

async function listTools(tools: ToolList = "core"): Promise<Tool[]> {
  const [response] = await session([{ method: "tools/list", params: {} }], tools);
  return (response.result?.tools as Tool[] | undefined) ?? [];
}

describe("the tool list a client sends to its model", () => {
  it("stays inside its byte budget", async () => {
    const tools = await listTools("core");
    const sizes = tools
      .map((tool) => ({ name: tool.name, bytes: Buffer.byteLength(JSON.stringify(tool)) }))
      .sort((a, b) => b.bytes - a.bytes);
    const total = Buffer.byteLength(JSON.stringify(tools));
    const largest = sizes
      .slice(0, 5)
      .map((tool) => `${tool.name} ${tool.bytes}`)
      .join(", ");

    expect(tools.length, "tool count").toBeLessThanOrEqual(MAX_TOOLS);
    expect(total, `total tool list bytes (largest: ${largest})`).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
    for (const tool of sizes) {
      expect(tool.bytes, `${tool.name} bytes`).toBeLessThanOrEqual(MAX_TOOL_BYTES);
    }
  });

  it("keeps every tool, listed or found, inside the per-tool budget", async () => {
    for (const tool of await listTools("all")) {
      expect(Buffer.byteLength(JSON.stringify(tool)), `${tool.name} bytes`).toBeLessThanOrEqual(MAX_TOOL_BYTES);
    }
  });

  it("names what every conversation needs within the instructions apps keep", async () => {
    await listTools("core");
    const kept = instructions.slice(0, KEPT_INSTRUCTIONS);
    for (const name of ["list_memory", "change_memory", "list_workspaces", GATE_TOOLS.find, GATE_TOOLS.read, GATE_TOOLS.write]) expect(kept).toContain(name);
    await listTools("all");
    expect(instructions.slice(0, KEPT_INSTRUCTIONS)).toContain("list_memory");
    expect(instructions).not.toContain(GATE_TOOLS.find);
  });

  it("lists the core tools and the gates, and every other tool in all", async () => {
    const core = (await listTools("core")).map((t) => t.name);
    const all = (await listTools("all")).map((t) => t.name);
    expect(new Set(core)).toEqual(new Set([...CORE_TOOLS, ...Object.values(GATE_TOOLS)]));
    for (const name of CORE_TOOLS) expect(all, name).toContain(name);
    for (const name of all) if (!CORE_TOOLS.has(name)) expect(toolCategory(name), `${name} has a category in catalog.ts`).not.toBe("other");
  });

  it("gives every tool a description and a unique name", async () => {
    const tools = await listTools("all");
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.size, "unique tool names").toBe(tools.length);
    for (const tool of tools) {
      expect(tool.description?.trim().length ?? 0, `${tool.name} has a description`).toBeGreaterThan(0);
    }
  });

  it("points only at docs topics there are", async () => {
    const text = JSON.stringify(await listTools("all"));
    const named = new Set([...text.matchAll(/leafdesk:\/\/docs\/([a-z-]+)/g)].map((m) => m[1]));
    expect(named.size).toBeGreaterThan(0);
    for (const topic of named) expect(DOC_TOPICS, `leafdesk://docs/${topic}`).toContain(topic);
  });
});

describe("the docs topics", () => {
  it("are listed and read as resources, with the full schemas the tool list leaves out", async () => {
    const [list, ...reads] = await session([
      { method: "resources/list", params: {} },
      ...DOC_TOPICS.map((topic) => ({ method: "resources/read", params: { uri: docUri(topic) } })),
    ]);
    const resources = list.result?.resources as { uri: string; title: string }[];
    expect(resources.map((r) => r.uri)).toEqual([...DOC_TOPICS.map(docUri), DATABASE_VIEW_URI]);
    const text = Object.fromEntries(
      reads.map((read, i) => [DOC_TOPICS[i], ((read.result?.contents as { text: string }[])[0]).text] as const),
    );
    expect(text.markdown).toContain("<!-- leafdesk:columns -->");
    expect(text.properties).toContain('prop("Name")');
    expect(text.filters).toContain("is_within");
    expect(text.filters).toContain("```json");
    expect(text.views).toContain("calendar_mode");
    expect(text.dashboards).toContain("database_id");
    expect(text.automations).toContain("row_created");
    expect(text.automations).toContain("for_each");
    expect(text["pdf-themes"]).toContain('{"type":"body"}');
  });

  it("refuses an address that names no topic", async () => {
    const [read] = await session([{ method: "resources/read", params: { uri: "leafdesk://docs/nothing" } }]);
    expect(read.error?.message).toMatch(/No such resource/);
  });

  it("are read by get_page too, for clients that don't read resources", async () => {
    const [call] = await session([{ method: "tools/call", params: { name: "get_page", arguments: { page_id: docUri("filters") } } }]);
    const content = (call.result?.content as { text: string }[])[0].text;
    expect(JSON.parse(content)).toMatchObject({ uri: docUri("filters"), title: "Filters and sorts" });
  });
});

describe("show_database's view", () => {
  it("is named by the tool in the list apps draw it from", async () => {
    const tools = (await listTools("core")) as (Tool & { _meta?: Record<string, unknown> })[];
    const tool = tools.find((t) => t.name === "show_database");
    expect(tool?._meta).toEqual({ ui: { resourceUri: DATABASE_VIEW_URI }, "ui/resourceUri": DATABASE_VIEW_URI });
  });

  it("is read as an MCP App page that loads nothing but the app's fonts", async () => {
    const [read] = await session([{ method: "resources/read", params: { uri: DATABASE_VIEW_URI } }]);
    const [page] = read.result?.contents as { uri: string; mimeType: string; text: string; _meta: unknown }[];
    expect(page).toMatchObject({
      uri: DATABASE_VIEW_URI,
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { prefersBorder: false, csp: { resourceDomains: ["https://assets.claude.ai"] } } },
    });
    expect(page.text).toMatch(/^<!doctype html>/);
    // No address of another site: no src or href attributes, scripts and styles inline.
    expect(page.text).not.toMatch(/\s(src|href)=/);
    // The language is the default one: the user's saved language can't be read without a database.
    expect(page.text).toContain('"open":"Open in Leafdesk"');
  });
});

describe("inputs shown only in outline", () => {
  it("are still checked in full when a tool is called", async () => {
    const [call] = await session([
      {
        method: "tools/call",
        params: { name: "query_database", arguments: { database_id: "db-1", filters: [{ property: "Status", op: "resembles", value: "x" }] } },
      },
    ]);
    const result = call.result as { isError?: boolean; content: { text: string }[] } | undefined;
    const message = result?.content[0].text ?? call.error?.message ?? "";
    expect(result?.isError ?? true).toBe(true);
    expect(message).toMatch(/filters/);
    expect(message).toMatch(/op/);
  });
});

describe("the tools the core list leaves out", () => {
  const call = (name: string, args: Record<string, unknown>) => session([{ method: "tools/call", params: { name, arguments: args } }]).then(([r]) => r);
  const text = (r: Response) => ((r.result?.content as { text: string }[] | undefined)?.[0]?.text ?? r.error?.message ?? "");

  it("are found by find_tools with what they take and how to call them", async () => {
    const found = text(await call(GATE_TOOLS.find, { query: "calendar view" }));
    expect(found).toMatch(/^## create_database_view \(Create a database view, views, changes something: call it with run_write_tool\)/);
    expect(found).toContain("Inputs (JSON schema)");
    expect(found).not.toContain("$schema");
    const all = text(await call(GATE_TOOLS.find, {}));
    expect(all).toMatch(/^All of them, by category: /);
    expect(all).toContain("views: create_database_view, update_database_view");
  });

  it("can't be called directly, only through the gates", async () => {
    const direct = await call("list_trash", { workspace_id: "ws-1" });
    expect(direct.error ?? (direct.result as { isError?: boolean }).isError).toBeTruthy();
    expect(text(await call(GATE_TOOLS.read, { name: "get_page", arguments: {} }))).toMatch(/in your tool list: call it directly/);
    expect(text(await call(GATE_TOOLS.read, { name: "no_such_tool", arguments: {} }))).toMatch(/There is no tool "no_such_tool"/);
  });

  it("are refused by run_read_tool when they change something", async () => {
    const r = await call(GATE_TOOLS.read, { name: "move_page", arguments: { page_id: "p-1" } });
    expect((r.result as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toBe("move_page changes something: call it with run_write_tool.");
  });

  it("have their own inputs checked, unknown arguments too", async () => {
    const r = await call(GATE_TOOLS.write, { name: "move_page", arguments: { page: "p-1" } });
    expect((r.result as { isError?: boolean }).isError).toBe(true);
    expect(text(r)).toMatch(/^Invalid arguments for move_page: .*Unknown argument "page"/);
  });
});
