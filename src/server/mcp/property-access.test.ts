import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpPrincipal } from "./principal";
import { createMcpServer } from "./tools";

// Property access as MCP tools show and change it (see server/property-access). The database layer
// is mocked: it redacts rows itself; these tests check what the tools make of what it returns.

vi.mock("@/db", () => ({ db: {} }));

const collab = vi.hoisted(() => ({ readPage: vi.fn(), broadcast: vi.fn(), appendBlocks: vi.fn() }));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => collab }));

const pages = vi.hoisted(() => ({
  getPage: vi.fn(),
  getBreadcrumbs: vi.fn(async () => []),
  listWorkspaces: vi.fn(async () => [{ id: "ws-1", name: "Team", icon: null, role: "member" }]),
  listChildren: vi.fn(async () => []),
}));
vi.mock("@/server/pages", () => pages);

const databases = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getRow: vi.fn(),
  listRows: vi.fn(async () => []),
  addView: vi.fn(),
  updateView: vi.fn(),
  updateRowProperties: vi.fn(),
  getLookups: vi.fn(async () => ({ relations: {}, people: [] })),
}));
vi.mock("@/server/databases", () => databases);

const propertyAccess = vi.hoisted(() => ({
  loadPropertyRules: vi.fn(async () => new Map()),
  getPropertyAccessSettings: vi.fn(),
  setPropertyAccess: vi.fn(),
}));
vi.mock("@/server/property-access", () => propertyAccess);

const forms = vi.hoisted(() => ({ formPublicationsOf: vi.fn(async () => new Map()) }));
vi.mock("@/server/forms", () => forms);

const workspaces = vi.hoisted(() => ({ listMembers: vi.fn() }));
vi.mock("@/server/workspaces", () => workspaces);

const groups = vi.hoisted(() => ({ listGroups: vi.fn() }));
vi.mock("@/server/groups", () => groups);

vi.mock("@/server/page-meta", () => ({ isFavorite: vi.fn(async () => false), listFavorites: vi.fn(async () => []) }));

vi.mock("@/server/mentions", () => ({
  labelPageLinks: vi.fn(async (_: string, markdown: string) => markdown),
  listBacklinks: vi.fn(async () => []),
}));
vi.mock("@/server/embeds", () => ({ resolveEmbeds: vi.fn(async () => []) }));

const files = vi.hoisted(() => ({ FileError: class extends Error {}, uploadFile: vi.fn(), uploadFromUrl: vi.fn() }));
vi.mock("@/server/files", () => files);

const writer: McpPrincipal = { userId: "user-1", clientId: "client-1", scopes: ["pages:read", "pages:write", "files:write"] };
const reader: McpPrincipal = { userId: "user-1", clientId: "client-1", scopes: ["pages:read"] };

async function callTool(principal: McpPrincipal, name: string, args: Record<string, unknown>) {
  const server = createMcpServer(principal);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  client.onmessage = (m) => void inbox.push(m);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      const hit = inbox.find((m) => "id" in m && m.id === id);
      if (hit) return hit as { result?: { isError?: boolean; content: { text: string }[] } };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no response for ${id}`);
  };
  await client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  await waitFor(1);
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const result = (await waitFor(2)).result!;
  await server.close();
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

const salary = { id: "prop-salary", name: "Salary", type: "number", options: {} };
const owner = { id: "prop-owner", name: "Owner", type: "person", options: {} };
const notes = { id: "prop-notes", name: "Notes", type: "text", options: {} };
// Reads a property the caller can't know of: its expression would name that property by id.
const bonus = { id: "prop-bonus", name: "Bonus", type: "formula", options: { formula: { expression: 'prop("prop-secret") * 2' } } };
const total = { id: "prop-total", name: "Total", type: "formula", options: { formula: { expression: 'prop("prop-salary") + 1' } } };

/** A PropertyAccess (server/property-access) for a viewer with this database level. */
function accessFor(databaseLevel: string, open = false) {
  return {
    open,
    viewer: { userId: "user-1", groupIds: [], databaseLevel },
    levelOf: () => "edit",
    info: () => undefined,
    visible: <P,>(p: P[]) => p,
    strip: <R,>(r: R[]) => r,
    finish: <R,>(r: R[]) => r,
    requireValues: vi.fn(),
    requireSchema: vi.fn(),
    viewConfig: vi.fn(<C extends { groupBy?: string }>(c: C) => (c.groupBy === "prop-secret" ? { ...c, groupBy: undefined } : c)),
  };
}

const restricted = {
  database: { id: "db-1", workspaceId: "ws-1", kind: "database", title: "People", archivedAt: null },
  properties: [salary, owner, notes, bonus, total],
  views: [],
  access: accessFor("edit"),
  propertyAccess: {
    "prop-salary": { level: "view_property", perRow: false },
    "prop-notes": { level: "view", perRow: true },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  databases.getDatabase.mockResolvedValue(restricted);
});

describe("get_database", () => {
  it("shows the caller's level on restricted properties and hides formulas over properties they can't know of", async () => {
    const { isError, data } = await callTool(reader, "get_database", { database_id: "db-1" });
    expect(isError).toBe(false);
    const byName = Object.fromEntries(data.properties.map((p: { name: string }) => [p.name, p]));
    expect(byName.Salary).toMatchObject({ access: "view_property" });
    expect(byName.Notes).toMatchObject({ access: "view", access_per_row: true });
    expect(byName.Owner.access).toBeUndefined();
    expect(byName.Bonus.formula).toBeNull();
    expect(byName.Total.formula).toBe('prop("Salary") + 1');
    expect(JSON.stringify(data)).not.toContain("prop-secret");
    // Settings are for people with full access only.
    expect(propertyAccess.loadPropertyRules).not.toHaveBeenCalled();
    expect(byName.Salary.access_settings).toBeUndefined();
  });

  it("gives people with full access each restricted property's settings", async () => {
    databases.getDatabase.mockResolvedValue({ ...restricted, access: accessFor("full"), propertyAccess: undefined });
    propertyAccess.loadPropertyRules.mockResolvedValue(new Map([["prop-salary", []]]));
    propertyAccess.getPropertyAccessSettings.mockResolvedValue({
      everyone: "view_property",
      exceptions: [
        { kind: "user", id: "user-2", name: "Ada", email: "ada@example.com", image: null, level: "edit_values" },
        { kind: "group", id: "group-1", name: "HR", level: "view" },
        { kind: "person", id: "prop-owner", name: "Owner", level: "view" },
      ],
    });
    const { data } = await callTool(reader, "get_database", { database_id: "db-1" });
    const salaryOut = data.properties.find((p: { name: string }) => p.name === "Salary");
    expect(propertyAccess.getPropertyAccessSettings).toHaveBeenCalledWith("user-1", "prop-salary");
    expect(salaryOut.access_settings).toEqual({
      everyone: "view_property",
      exceptions: [
        { user_id: "user-2", name: "Ada", email: "ada@example.com", level: "edit_values" },
        { group_id: "group-1", group: "HR", level: "view" },
        { person_property: "Owner", level: "view" },
      ],
    });
    expect(data.properties.find((p: { name: string }) => p.name === "Notes").access_settings).toBeUndefined();
  });
});

describe("query_database", () => {
  it("refuses filters and sorts on values the caller can't see in any row", async () => {
    const filtered = await callTool(reader, "query_database", {
      database_id: "db-1",
      filters: [{ type: "group", combinator: "or", rules: [{ property: "Salary", op: "gt", value: 100 }] }],
    });
    expect(filtered.isError).toBe(true);
    expect(filtered.text).toMatch(/can't see the values of "Salary"/);
    const sorted = await callTool(reader, "query_database", { database_id: "db-1", sorts: [{ property: "Salary" }] });
    expect(sorted.isError).toBe(true);
    expect(databases.listRows).not.toHaveBeenCalled();
  });

  it("filters on properties rows decide, and names what each row leaves out", async () => {
    databases.listRows.mockResolvedValue([
      { id: "r1", title: "A", properties: { "prop-notes": "hi" }, hidden: ["prop-salary"], readOnly: ["prop-notes"] },
      { id: "r2", title: "B", properties: {} },
    ] as never);
    const { isError, data } = await callTool(reader, "query_database", {
      database_id: "db-1",
      filters: [{ property: "Notes", op: "is_not_empty" }],
    });
    expect(isError).toBe(false);
    expect(data.rows[0]).toMatchObject({ hidden_properties: ["Salary"], read_only_properties: ["Notes"] });
    expect(data.rows[1].hidden_properties).toBeUndefined();
  });
});

describe("rows", () => {
  it("get_page reads a row's values through its property access", async () => {
    const row = { id: "row-1", workspaceId: "ws-1", parentId: "db-1", kind: "page", title: "Ada", icon: null, properties: {}, archivedAt: null, updatedAt: new Date() };
    pages.getPage.mockImplementation(async (_: string, id: string) =>
      id === "db-1" ? { ...restricted.database, parentId: null, updatedAt: new Date() } : row,
    );
    collab.readPage.mockResolvedValue({ title: "Ada", markdown: "" });
    databases.getRow.mockResolvedValue({
      databaseId: "db-1",
      row: { id: "row-1", title: "Ada", properties: { "prop-notes": "Kind" }, hidden: ["prop-salary"] },
      properties: [salary, notes],
      relations: {},
      people: [],
    });
    const { isError, data } = await callTool(reader, "get_page", { page_id: "row-1" });
    expect(isError).toBe(false);
    expect(databases.getRow).toHaveBeenCalledWith("user-1", "row-1");
    expect(data.properties).toEqual({ Notes: "Kind" });
    expect(data.hidden_properties).toEqual(["Salary"]);
  });

  it("attach_file checks the files property can be changed before uploading", async () => {
    const access = accessFor("edit");
    access.requireValues.mockImplementation(() => {
      throw Object.assign(new Error(`You can't change "Photos"`), { name: "PropertyValueError" });
    });
    const photos = { id: "prop-photos", name: "Photos", type: "files", options: {} };
    databases.getDatabase.mockResolvedValue({ ...restricted, properties: [photos], access });
    const row = { id: "row-1", workspaceId: "ws-1", parentId: "db-1", kind: "page", title: "Ada", properties: {}, archivedAt: null };
    pages.getPage.mockImplementation(async (_: string, id: string) => (id === "db-1" ? { ...restricted.database } : row));
    const r = await callTool(writer, "attach_file", { page_id: "row-1", url: "https://example.com/a.png", property: "Photos" });
    expect(r.isError).toBe(true);
    expect(access.requireValues).toHaveBeenCalledWith(row, ["prop-photos"]);
    expect(files.uploadFromUrl).not.toHaveBeenCalled();
  });
});

describe("views", () => {
  it("create_database_view shows a new view without defaults naming properties the caller can't know of", async () => {
    databases.addView.mockResolvedValue({ id: "view-1", name: "Board", type: "board", config: { groupBy: "prop-secret" } });
    const { isError, data } = await callTool(writer, "create_database_view", { database_id: "db-1", name: "Board", type: "board" });
    expect(isError).toBe(false);
    expect(restricted.access.viewConfig).toHaveBeenCalledWith({ groupBy: "prop-secret" });
    expect(JSON.stringify(data)).not.toContain("prop-secret");
    expect(databases.updateView).not.toHaveBeenCalled();
  });
});

describe("set_property_access", () => {
  const settings = { everyone: "view_property", exceptions: [] };

  it("names people by email, groups by name and person properties by name", async () => {
    workspaces.listMembers.mockResolvedValue([{ userId: "user-2", name: "Ada", email: "Ada@Example.com" }]);
    groups.listGroups.mockResolvedValue([{ id: "group-1", name: "HR" }]);
    propertyAccess.getPropertyAccessSettings.mockResolvedValue(settings);
    const { isError, data } = await callTool(writer, "set_property_access", {
      database_id: "db-1",
      property: "salary",
      everyone: "view_property",
      exceptions: [
        { user: "ada@example.com", level: "edit" },
        { group: "hr", level: "view" },
        { person_property: "Owner", level: "view" },
      ],
    });
    expect(isError).toBe(false);
    expect(propertyAccess.setPropertyAccess).toHaveBeenCalledWith("user-1", "prop-salary", {
      everyone: "view_property",
      exceptions: [
        { userId: "user-2", level: "edit" },
        { groupId: "group-1", level: "view" },
        { personPropertyId: "prop-owner", level: "view" },
      ],
    });
    expect(data).toMatchObject({ database_id: "db-1", property: "Salary", property_id: "prop-salary", everyone: "view_property" });
  });

  it("refuses exceptions it can't resolve, and read-only connections", async () => {
    workspaces.listMembers.mockResolvedValue([]);
    const unknown = await callTool(writer, "set_property_access", {
      database_id: "db-1",
      property: "Salary",
      everyone: "none",
      exceptions: [{ user: "nobody@example.com", level: "view" }],
    });
    expect(unknown.text).toMatch(/not a person of this workspace/);
    const two = await callTool(writer, "set_property_access", {
      database_id: "db-1",
      property: "Salary",
      everyone: "none",
      exceptions: [{ group: "HR", person_property: "Owner", level: "view" }],
    });
    expect(two.text).toMatch(/exactly one/);
    const notPerson = await callTool(writer, "set_property_access", {
      database_id: "db-1",
      property: "Salary",
      everyone: "none",
      exceptions: [{ person_property: "Notes", level: "view" }],
    });
    expect(notPerson.text).toMatch(/person or created_by/);
    const readOnly = await callTool(reader, "set_property_access", { database_id: "db-1", property: "Salary", everyone: "inherit" });
    expect(readOnly.isError).toBe(true);
    expect(propertyAccess.setPropertyAccess).not.toHaveBeenCalled();
  });
});
