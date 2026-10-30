import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { DOC_TOPICS, docUri } from "./docs";
import { createMcpServer } from "./tools";

// Every tool schema is sent to the model on every session, so the whole list has a budget.
// Raise a number only on purpose, in the same commit, and say why in the CHANGELOG. What a model
// needs only now and then goes into the docs topics (docs.ts), which cost nothing until read.
vi.mock("@/db", () => ({ db: {} }));

const MAX_TOOLS = 92;
const MAX_TOTAL_BYTES = 168_500;
const MAX_TOOL_BYTES = 12_000;

type Tool = { name: string; description?: string; inputSchema?: unknown };
type Response = { result?: Record<string, unknown>; error?: { message: string } };

/** Sends `requests` (method and params) to a fresh server after initializing, and returns their responses in order. */
async function session(requests: { method: string; params: Record<string, unknown> }[]): Promise<Response[]> {
  const server = createMcpServer({ userId: "user-1", clientId: "client-1", scopes: ["*"] } as never);
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
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const responses: Response[] = [];
  for (const [i, request] of requests.entries()) {
    await client.send({ jsonrpc: "2.0", id: i + 2, ...request });
    responses.push(await waitFor(i + 2));
  }
  await server.close();
  return responses;
}

async function listTools(): Promise<Tool[]> {
  const [response] = await session([{ method: "tools/list", params: {} }]);
  return (response.result?.tools as Tool[] | undefined) ?? [];
}

describe("the tool list a client sends to its model", () => {
  it("stays inside its byte budget", async () => {
    const tools = await listTools();
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

  it("gives every tool a description and a unique name", async () => {
    const tools = await listTools();
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.size, "unique tool names").toBe(tools.length);
    for (const tool of tools) {
      expect(tool.description?.trim().length ?? 0, `${tool.name} has a description`).toBeGreaterThan(0);
    }
  });

  it("points only at docs topics there are", async () => {
    const text = JSON.stringify(await listTools());
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
    expect(resources.map((r) => r.uri)).toEqual(DOC_TOPICS.map(docUri));
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
