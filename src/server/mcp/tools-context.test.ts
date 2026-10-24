import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "./tools";

// Every tool schema is sent to the model on every session, so the whole list has a budget.
// Raise a number only on purpose, in the same commit, and say why in the CHANGELOG.
vi.mock("@/db", () => ({ db: {} }));

const MAX_TOOLS = 100;
const MAX_TOTAL_BYTES = 276_000;
const MAX_TOOL_BYTES = 25_000;

type Tool = { name: string; description?: string; inputSchema?: unknown };

async function listTools(): Promise<Tool[]> {
  const server = createMcpServer({ userId: "user-1", clientId: "client-1", scopes: ["*"] } as never);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  client.onmessage = (message) => void inbox.push(message);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const hit = inbox.find((message) => "id" in message && message.id === id);
      if (hit) return hit as { result?: { tools: Tool[] } };
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
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = (await waitFor(2)).result?.tools ?? [];
  await server.close();
  return tools;
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
});
