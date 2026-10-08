import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PropertyValueError } from "@/lib/properties";
import { AccessError } from "@/server/access";
import { MAX_MARKDOWN_CHARS } from "./format";
import type { McpPrincipal } from "./principal";
import { createMcpServer } from "./tools";

vi.mock("@/db", () => ({ db: {} }));

const collab = vi.hoisted(() => ({
  readPage: vi.fn(),
  replaceContent: vi.fn(),
  appendContent: vi.fn(),
  appendBlocks: vi.fn(),
  setTitle: vi.fn(),
  restoreSnapshot: vi.fn(),
  broadcast: vi.fn(),
}));
vi.mock("@/server/collab/bridge", () => ({ getCollab: () => collab }));

const pages = vi.hoisted(() => ({
  getPage: vi.fn(),
  getBreadcrumbs: vi.fn(),
  listWorkspaces: vi.fn(),
  listChildren: vi.fn(),
  createPage: vi.fn(),
  renamePage: vi.fn(),
  archivePage: vi.fn(),
  searchPages: vi.fn(),
  movePage: vi.fn(),
  recentPages: vi.fn(),
  listTrash: vi.fn(),
  restorePage: vi.fn(),
  listSnapshots: vi.fn(),
  getSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
}));
vi.mock("@/server/pages", () => pages);

const databases = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  listRows: vi.fn(),
  updateRowProperties: vi.fn(),
  updateRowsProperties: vi.fn(),
  createRows: vi.fn(),
  addProperty: vi.fn(),
  updateProperty: vi.fn(),
  changePropertyType: vi.fn(),
  deleteProperty: vi.fn(),
  addView: vi.fn(),
  updateView: vi.fn(),
  moveView: vi.fn(),
  getLookups: vi.fn(async () => ({ relations: {}, people: [] })),
  makeOption: vi.fn((name: string, index: number) => ({ id: `opt-new-${index}`, name: name.trim(), color: "gray" })),
}));
vi.mock("@/server/databases", () => databases);

const pageHistory = vi.hoisted(() => ({ diffSnapshot: vi.fn() }));
vi.mock("@/server/page-history", () => pageHistory);

const teamspaces = vi.hoisted(() => ({
  listTeamspaces: vi.fn(),
  getTeamspace: vi.fn(),
  teamspaceLabel: vi.fn(async (_: string, id: string) => (id === "ts-1" ? { id, name: "Engineering", icon: null } : null)),
}));
vi.mock("@/server/teamspaces", () => teamspaces);

const groups = vi.hoisted(() => ({ listGroups: vi.fn() }));
vi.mock("@/server/groups", () => groups);

const workspaces = vi.hoisted(() => {
  class WorkspaceError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { WorkspaceError, listMembers: vi.fn(), addMembers: vi.fn(), workspacePeople: vi.fn(async () => []) };
});
vi.mock("@/server/workspaces", () => workspaces);

const notifications = vi.hoisted(() => ({ listNotifications: vi.fn() }));
vi.mock("@/server/notifications", () => notifications);

const automations = vi.hoisted(() => ({
  listAutomations: vi.fn(),
  createAutomation: vi.fn(),
  updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(),
  rotateAutomationSecret: vi.fn(),
  testAutomationWebhooks: vi.fn(),
  listAutomationRuns: vi.fn(),
}));
vi.mock("@/server/automations/manage", () => automations);

const agents = vi.hoisted(() => {
  class AgentError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly params: Record<string, string> = {},
    ) {
      super(message);
    }
  }
  return {
    AgentError,
    listAgents: vi.fn(async () => [] as unknown[]),
    getAgent: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    archiveAgent: vi.fn(),
    restoreAgent: vi.fn(),
    listAgentAccess: vi.fn(),
    setAgentAccess: vi.fn(),
    removeAgentAccess: vi.fn(),
    listAgentRuns: vi.fn(),
  };
});
vi.mock("@/server/agents/manage", () => agents);

const files = vi.hoisted(() => {
  class FileError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return { FileError, uploadFile: vi.fn(), uploadFromUrl: vi.fn(), fileForApp: vi.fn(), readStored: vi.fn() };
});
vi.mock("@/server/files", () => files);

const duplicate = vi.hoisted(() => ({ duplicatePage: vi.fn(), MAX_DUPLICATE_PAGES: 2000 }));
vi.mock("@/server/duplicate", () => duplicate);

const pageMeta = vi.hoisted(() => ({ isFavorite: vi.fn(async () => false), listFavorites: vi.fn() }));
vi.mock("@/server/page-meta", () => pageMeta);
const mentions = vi.hoisted(() => ({
  labelPageLinks: vi.fn(async (_userId: string, markdown: string) => markdown),
  listBacklinks: vi.fn(async () => []),
}));
vi.mock("@/server/mentions", () => mentions);

const page = {
  id: "page-1",
  workspaceId: "ws-1",
  parentId: null,
  kind: "page",
  title: "Plan",
  icon: null,
  properties: {},
  archivedAt: null,
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const status = {
  id: "prop-status",
  name: "Status",
  type: "select",
  options: {
    options: [
      { id: "opt-todo", name: "Todo", color: "gray" },
      { id: "opt-done", name: "Done", color: "green" },
    ],
  },
};
const notes = { id: "prop-notes", name: "Notes", type: "text", options: {} };
/** Property access of a database without rules (server/property-access OPEN_ACCESS). */
const openAccess = {
  open: true,
  viewer: null,
  levelOf: () => "edit",
  info: () => undefined,
  visible: <P,>(properties: P[]) => properties,
  strip: <R,>(rows: R[]) => rows,
  finish: <R,>(rows: R[]) => rows,
  requireValues: () => {},
  requireSchema: () => {},
  viewConfig: <C,>(config: C) => config,
};
const database = {
  database: { id: "db-1", workspaceId: "ws-1", kind: "database", title: "Tasks", archivedAt: null },
  access: openAccess,
  propertyAccess: undefined as Record<string, { level: string; perRow: boolean }> | undefined,
  properties: [status, notes],
  views: [{ id: "view-1", name: "Board", type: "board", config: { groupBy: "prop-status", sorts: [{ propertyId: "title", direction: "asc" }] } }],
};

const writer: McpPrincipal = { userId: "user-1", clientId: "client-1", scopes: ["pages:read", "pages:write"] };
const reader: McpPrincipal = { userId: "user-1", clientId: "client-1", scopes: ["pages:read"] };

/** Calls one tool over an in-memory 2025-era session. */
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
      if (hit) return hit as { result?: any; error?: any };
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
  const response = await waitFor(2);
  await server.close();
  const result = response.result as { isError?: boolean; content: { type: string; text: string; data?: string; mimeType?: string }[] };
  const text = result.content[0].text;
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text), content: result.content };
}

type ListedTool = { name: string; inputSchema: Record<string, any>; annotations?: Record<string, boolean> };

/** The tools a session lists. */
async function listTools(principal: McpPrincipal): Promise<ListedTool[]> {
  const server = createMcpServer(principal);
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  const inbox: JSONRPCMessage[] = [];
  client.onmessage = (m) => void inbox.push(m);
  await server.connect(serverSide);
  await client.start();
  const waitFor = async (id: number) => {
    for (let i = 0; i < 200; i++) {
      const hit = inbox.find((m) => "id" in m && m.id === id);
      if (hit) return hit as { result?: any };
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
  await client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const response = await waitFor(2);
  await server.close();
  return response.result.tools;
}

beforeEach(() => {
  vi.clearAllMocks();
  pages.getPage.mockResolvedValue(page);
  pages.getBreadcrumbs.mockResolvedValue([{ id: "page-1", title: "Plan", icon: null, kind: "page" }]);
  pages.listWorkspaces.mockResolvedValue([{ id: "ws-1", name: "Team", icon: null, role: "owner" }]);
  pages.listChildren.mockResolvedValue([]);
  collab.readPage.mockResolvedValue({ title: "Plan", markdown: "Hello", text: "Hello" });
  databases.getDatabase.mockResolvedValue(database);
});

describe("content writes", () => {
  it("replace snapshots first and attributes the write to the OAuth client", async () => {
    const r = await callTool(writer, "update_page", { page_id: "page-1", markdown: "# New" });
    expect(r.isError).toBe(false);
    expect(collab.replaceContent).toHaveBeenCalledWith("page-1", "# New", { userId: "user-1", oauthClientId: "client-1" }, true);
    expect(r.data.url).toBe("http://localhost:3000/w/ws-1/p/page-1");
  });

  it("append snapshots first too", async () => {
    await callTool(writer, "update_page", { page_id: "page-1", markdown: "- more", mode: "append" });
    expect(collab.appendContent).toHaveBeenCalledWith("page-1", "- more", expect.anything(), true);
    expect(collab.replaceContent).not.toHaveBeenCalled();
  });

  it("refuses to write into trashed pages", async () => {
    pages.getPage.mockResolvedValue({ ...page, archivedAt: new Date() });
    const r = await callTool(writer, "update_page", { page_id: "page-1", markdown: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/trash/);
    expect(collab.replaceContent).not.toHaveBeenCalled();
  });

  it("read-only tokens cannot write even without an HTTP scope challenge", async () => {
    const r = await callTool(reader, "create_page", { workspace_id: "ws-1", title: "Nope" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read-only/);
    expect(pages.createPage).not.toHaveBeenCalled();
  });
});

describe("errors and bounds", () => {
  it("turns access errors into actionable tool errors", async () => {
    pages.getPage.mockRejectedValue(new AccessError());
    const r = await callTool(reader, "get_page", { page_id: "missing" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not found or access denied.*search/);
  });

  it("hides unexpected errors", async () => {
    pages.searchPages.mockRejectedValue(new Error('relation "page" does not exist'));
    const r = await callTool(reader, "search", { query: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toMatch(/relation/);
  });

  it("truncates long bodies and says how to continue", async () => {
    collab.readPage.mockResolvedValue({ title: "Plan", markdown: "a".repeat(MAX_MARKDOWN_CHARS + 10), text: "" });
    const r = await callTool(reader, "get_page", { page_id: "page-1" });
    expect(r.data.markdown).toHaveLength(MAX_MARKDOWN_CHARS);
    expect(r.data.markdown_truncated).toBe(true);
    expect(r.data.note).toMatch(`offset=${MAX_MARKDOWN_CHARS}`);
    expect(r.data.path).toBe("Team / Plan");
  });
});

describe("move_page", () => {
  it("refuses to move a page inside its own sub-tree", async () => {
    pages.getPage.mockImplementation(async (_: string, id: string) => (id === "child" ? { ...page, id: "child", parentId: "page-1" } : page));
    pages.getBreadcrumbs.mockResolvedValue([{ id: "page-1" }, { id: "child" }]);
    const r = await callTool(writer, "move_page", { page_id: "page-1", parent_id: "child" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/inside itself/);
    expect(pages.movePage).not.toHaveBeenCalled();
  });

  it("refuses to move across workspaces", async () => {
    pages.getPage.mockImplementation(async (_: string, id: string) => (id === "other" ? { ...page, id: "other", workspaceId: "ws-2" } : page));
    const r = await callTool(writer, "move_page", { page_id: "page-1", parent_id: "other" });
    expect(r.text).toMatch(/another workspace/);
    expect(pages.movePage).not.toHaveBeenCalled();
  });

  it("moves to the top level with parent_id null and says when a row leaves its database", async () => {
    pages.getPage.mockImplementation(async (_: string, id: string) =>
      id === "db-1" ? { ...page, id: "db-1", kind: "database" } : { ...page, parentId: "db-1" },
    );
    const r = await callTool(writer, "move_page", { page_id: "page-1", parent_id: null });
    expect(pages.movePage).toHaveBeenCalledWith("user-1", "page-1", null, undefined, undefined);
    expect(r.data.parent_id).toBeNull();
    expect(r.data.note).toMatch(/no longer a database row/);
  });

  it("moves a top-level page to another teamspace or to the private pages", async () => {
    pages.getPage.mockResolvedValue({ ...page, teamspaceId: "ts-1" });
    await callTool(writer, "move_page", { page_id: "page-1", parent_id: null, teamspace_id: "private" });
    expect(pages.movePage).toHaveBeenLastCalledWith("user-1", "page-1", null, undefined, null);
    await callTool(writer, "move_page", { page_id: "page-1", parent_id: null, teamspace_id: "ts-2" });
    expect(pages.movePage).toHaveBeenLastCalledWith("user-1", "page-1", null, undefined, "ts-2");
  });

  it("leaves a page where it is when it is already at the top of that teamspace", async () => {
    pages.getPage.mockResolvedValue({ ...page, teamspaceId: "ts-1" });
    await callTool(writer, "move_page", { page_id: "page-1", parent_id: null, teamspace_id: "ts-1" });
    expect(pages.movePage).not.toHaveBeenCalled();
  });
});

describe("groups", () => {
  it("lists a workspace's groups with who is in them and the teamspaces they joined", async () => {
    groups.listGroups.mockResolvedValue([
      {
        id: "g-1",
        name: "Design",
        memberCount: 2,
        members: [
          { userId: "user-2", name: "Ada", email: "ada@example.com", image: null },
          { userId: "user-3", name: "Linus", email: "linus@example.com", image: "/a.png" },
        ],
        teamspaces: [{ id: "ts-1", name: "Engineering", icon: null }],
        createdAt: new Date(),
      },
    ]);
    const r = await callTool(reader, "list_groups", { workspace_id: "ws-1" });
    expect(groups.listGroups).toHaveBeenCalledWith("user-1", "ws-1");
    expect(r.data).toEqual({
      groups: [
        {
          id: "g-1",
          name: "Design",
          member_count: 2,
          members: [
            { id: "user-2", name: "Ada", email: "ada@example.com" },
            { id: "user-3", name: "Linus", email: "linus@example.com" },
          ],
          teamspaces: [{ id: "ts-1", name: "Engineering" }],
        },
      ],
    });
  });

  it("refuses guests and other workspaces the same way as a missing workspace", async () => {
    groups.listGroups.mockRejectedValue(new AccessError());
    const r = await callTool(reader, "list_groups", { workspace_id: "ws-2" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Not found or access denied/);
  });
});

describe("teamspaces", () => {
  it("lists teamspaces with their access and whether pages can be added", async () => {
    teamspaces.listTeamspaces.mockResolvedValue([
      {
        id: "ts-1",
        name: "Engineering",
        icon: null,
        description: "",
        access: "open",
        archivedAt: null,
        memberCount: 3,
        owners: [{ id: "user-2", name: "Ada" }],
        joined: false,
        role: null,
      },
    ]);
    const r = await callTool(reader, "list_teamspaces", { workspace_id: "ws-1" });
    expect(teamspaces.listTeamspaces).toHaveBeenCalledWith("user-1", "ws-1", { archived: "active" });
    expect(r.data.teamspaces[0]).toMatchObject({ id: "ts-1", access: "open", joined: false, can_add_pages: false, owners: ["Ada"] });
  });

  it("creates top-level pages as private unless a teamspace is named", async () => {
    pages.createPage.mockResolvedValue({ ...page, id: "new-1" });
    await callTool(writer, "create_page", { workspace_id: "ws-1", title: "Mine" });
    expect(pages.createPage.mock.calls[0][1]).toMatchObject({ workspaceId: "ws-1", parentId: null, teamspaceId: null });
    teamspaces.getTeamspace.mockResolvedValue({ id: "ts-1", workspaceId: "ws-1" });
    await callTool(writer, "create_page", { teamspace_id: "ts-1", title: "Team page" });
    expect(pages.createPage.mock.calls[1][1]).toMatchObject({ workspaceId: "ws-1", parentId: null, teamspaceId: "ts-1" });
  });

  it("refuses a teamspace the user can't see without telling it apart from a missing one", async () => {
    teamspaces.getTeamspace.mockRejectedValue(new AccessError());
    const r = await callTool(writer, "create_page", { teamspace_id: "ts-secret", title: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Unknown teamspace_id/);
    expect(pages.createPage).not.toHaveBeenCalled();
  });

  it("names the teamspace of a page, and private for pages outside any", async () => {
    pages.getPage.mockResolvedValue({ ...page, teamspaceId: "ts-1" });
    const inTeam = await callTool(reader, "get_page", { page_id: "page-1" });
    expect(inTeam.data).toMatchObject({ teamspace_id: "ts-1", teamspace: "Engineering" });
    pages.getPage.mockResolvedValue({ ...page, teamspaceId: null });
    const mine = await callTool(reader, "get_page", { page_id: "page-1" });
    expect(mine.data).toMatchObject({ teamspace_id: null, teamspace: "Private" });
  });
});

describe("database properties", () => {
  it("renames, removes and adds options without changing kept option ids", async () => {
    const r = await callTool(writer, "update_database_property", {
      database_id: "db-1",
      property: "status",
      name: "State",
      rename_options: [{ from: "todo", to: "To do" }],
      remove_options: ["Done"],
      add_options: ["Blocked", "to do"],
    });
    expect(r.isError).toBe(false);
    expect(databases.updateProperty).toHaveBeenCalledWith("user-1", "prop-status", {
      name: "State",
      options: [
        { id: "opt-todo", name: "To do", color: "gray" },
        { id: "opt-new-1", name: "Blocked", color: "gray" },
      ],
    });
    expect(r.data.property).toEqual({ id: "prop-status", name: "State", type: "select", options: ["To do", "Blocked"] });
  });

  it("adds status options to groups and moves them between groups", async () => {
    const stage = {
      id: "prop-stage",
      name: "Stage",
      type: "status",
      options: {
        options: [
          { id: "s-new", name: "New", color: "gray", group: "todo" },
          { id: "s-done", name: "Shipped", color: "green", group: "done" },
        ],
      },
    };
    databases.getDatabase.mockResolvedValueOnce({ database: { id: "db-1", workspaceId: "ws-1" }, access: openAccess, properties: [stage], views: [] });
    const r = await callTool(writer, "update_database_property", {
      database_id: "db-1",
      property: "Stage",
      add_options: [{ name: "Review", group: "in_progress" }, "Idea"],
      option_groups: [{ option: "shipped", group: "in_progress" }],
    });
    expect(r.isError).toBe(false);
    expect(databases.updateProperty.mock.calls[0][2].options.map((o: { name: string; group: string }) => [o.name, o.group])).toEqual([
      ["New", "todo"],
      ["Idea", "todo"],
      ["Shipped", "in_progress"],
      ["Review", "in_progress"],
    ]);
    expect(r.data.property.status_groups).toEqual({ todo: ["New", "Idea"], in_progress: ["Shipped", "Review"], done: [] });
    const wrong = await callTool(writer, "update_database_property", {
      database_id: "db-1",
      property: "Status",
      option_groups: [{ option: "Todo", group: "done" }],
    });
    expect(wrong.text).toMatch(/only status options belong to groups/);
  });

  it("names the existing options when one is unknown", async () => {
    const r = await callTool(writer, "update_database_property", { database_id: "db-1", property: "Status", remove_options: ["Later"] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Options: Todo, Done/);
    expect(databases.updateProperty).not.toHaveBeenCalled();
  });

  it("rejects option changes on non-select properties and duplicate names", async () => {
    const opts = await callTool(writer, "update_database_property", { database_id: "db-1", property: "Notes", add_options: ["x"] });
    expect(opts.text).toMatch(/only select, multi_select and status/);
    const dup = await callTool(writer, "update_database_property", { database_id: "db-1", property: "Notes", name: "status" });
    expect(dup.text).toMatch(/already exists/);
    expect(databases.updateProperty).not.toHaveBeenCalled();
  });

  it("changes a type by name, with a dry run that changes nothing", async () => {
    const planned = { ...notes, type: "select", options: { options: [{ id: "opt-a", name: "Alpha", color: "gray" }] } };
    databases.changePropertyType.mockResolvedValue({ property: planned, converted: 2, cleared: 1 });
    const dry = await callTool(writer, "change_database_property_type", { database_id: "db-1", property: "notes", type: "select", dry_run: true });
    expect(dry.isError).toBe(false);
    expect(databases.changePropertyType).toHaveBeenCalledWith("user-1", "prop-notes", { type: "select", yes: "Yes" }, { dryRun: true });
    expect(dry.data).toMatchObject({ dry_run: true, converted: 2, cleared: 1, property: { name: "Notes", type: "select", options: ["Alpha"] } });
    await callTool(writer, "change_database_property_type", {
      database_id: "db-1",
      property: "Notes",
      type: "relation",
      related_database_id: "db-2",
      two_way: true,
    });
    expect(databases.changePropertyType).toHaveBeenLastCalledWith(
      "user-1",
      "prop-notes",
      { type: "relation", relation: { databaseId: "db-2", twoWay: true, pairedName: undefined }, yes: "Yes" },
      { dryRun: false },
    );
  });

  it("asks for what the new type needs, refuses the same type and read-only tokens", async () => {
    const formula = await callTool(writer, "change_database_property_type", { database_id: "db-1", property: "Notes", type: "formula" });
    expect(formula.text).toMatch(/needs formula/);
    const relation = await callTool(writer, "change_database_property_type", { database_id: "db-1", property: "Notes", type: "relation" });
    expect(relation.text).toMatch(/related_database_id/);
    const same = await callTool(writer, "change_database_property_type", { database_id: "db-1", property: "Notes", type: "text" });
    expect(same.text).toMatch(/already a text property/);
    const denied = await callTool(reader, "change_database_property_type", { database_id: "db-1", property: "Notes", type: "number" });
    expect(denied.text).toMatch(/read-only/);
    expect(databases.changePropertyType).not.toHaveBeenCalled();
  });

  it("deletes by name, and read-only tokens cannot", async () => {
    const denied = await callTool(reader, "delete_database_property", { database_id: "db-1", property: "Notes" });
    expect(denied.text).toMatch(/read-only/);
    const r = await callTool(writer, "delete_database_property", { database_id: "db-1", property: "notes" });
    expect(databases.deleteProperty).toHaveBeenCalledWith("user-1", "prop-notes");
    expect(r.data.deleted.name).toBe("Notes");
  });
});

describe("relations and calendars", () => {
  it("needs a related database for a relation and passes the two-way settings", async () => {
    const missing = await callTool(writer, "add_database_property", { database_id: "db-1", name: "Customer", type: "relation" });
    expect(missing.text).toMatch(/related_database_id/);
    const misplaced = await callTool(writer, "add_database_property", {
      database_id: "db-1",
      name: "Due",
      type: "date",
      related_database_id: "db-2",
    });
    expect(misplaced.text).toMatch(/only apply to relation/);
    databases.addProperty.mockResolvedValue({
      id: "prop-customer",
      name: "Customer",
      type: "relation",
      options: { relation: { databaseId: "db-2", pairedPropertyId: "prop-jobs" } },
    });
    const r = await callTool(writer, "add_database_property", {
      database_id: "db-1",
      name: "Customer",
      type: "relation",
      related_database_id: "db-2",
      two_way: true,
      paired_property_name: "Jobs",
    });
    expect(databases.addProperty).toHaveBeenCalledWith("user-1", "db-1", {
      name: "Customer",
      type: "relation",
      options: undefined,
      relation: { databaseId: "db-2", twoWay: true, pairedName: "Jobs" },
    });
    expect(r.data.property).toMatchObject({ related_database_id: "db-2", two_way: true });
  });

  it("creates timelines with start, end, swimlanes and zoom, and checks each setting's view type", async () => {
    const due = { id: "prop-due", name: "Due", type: "date", options: {} };
    const starts = { id: "prop-start", name: "Starts", type: "date", options: {} };
    databases.getDatabase.mockResolvedValue({ ...database, properties: [status, notes, due, starts] });
    const onGallery = await callTool(writer, "create_database_view", { database_id: "db-1", name: "G", type: "gallery", zoom: "day" });
    expect(onGallery.text).toMatch(/zoom only applies to timeline/);
    const badEnd = await callTool(writer, "create_database_view", { database_id: "db-1", name: "T", type: "timeline", end_date_by: "Notes" });
    expect(badEnd.text).toMatch(/end at a date property/);
    expect(databases.addView).not.toHaveBeenCalled();
    databases.addView.mockResolvedValue({ id: "view-4", name: "Plan", type: "timeline", config: { dateBy: "prop-due" } });
    const r = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "Plan",
      type: "timeline",
      date_by: "Starts",
      end_date_by: "Due",
      group_by: "Status",
      zoom: "month",
    });
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-4", {
      config: { dateBy: "prop-start", endDateBy: "prop-due", groupBy: "prop-status", zoom: "month" },
    });
    expect(r.data).toMatchObject({ type: "timeline", date_by: "Starts", end_date_by: "Due", group_by: "Status", zoom: "month" });
  });

  it("removes timeline swimlanes with a null group_by and sets gallery cards", async () => {
    const views = [
      { id: "view-t", name: "Plan", type: "timeline", config: { dateBy: "prop-due", groupBy: "prop-status" } },
      { id: "view-g", name: "Cards", type: "gallery", config: {} },
    ];
    databases.getDatabase.mockResolvedValue({ ...database, views });
    await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-t", group_by: null });
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-t", { config: { dateBy: "prop-due", groupBy: undefined } });
    const r = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-g", card_size: "large", cover: "none" });
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-g", {
      config: { cardSize: "large", cover: { source: "none" } },
    });
    expect(r.data).toMatchObject({ card_size: "large", cover: "none" });
  });

  it("creates charts with a calculation, stacking and sort, and checks each setting", async () => {
    const amount = { id: "prop-amount", name: "Amount", type: "number", options: {} };
    const done = { id: "prop-done", name: "Done", type: "checkbox", options: {} };
    databases.getDatabase.mockResolvedValue({ ...database, properties: [status, notes, amount, done] });
    const onTable = await callTool(writer, "create_database_view", { database_id: "db-1", name: "T", type: "table", chart_type: "line" });
    expect(onTable.text).toMatch(/chart_type only applies to chart views/);
    const noProperty = await callTool(writer, "create_database_view", { database_id: "db-1", name: "C", type: "chart", aggregate: "sum" });
    expect(noProperty.text).toMatch(/needs aggregate_property/);
    const wrongType = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "C",
      type: "chart",
      aggregate: "sum",
      aggregate_property: "Notes",
    });
    expect(wrongType.text).toMatch(/can't calculate sum over "Notes"/);
    const averageStack = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "C",
      type: "chart",
      aggregate: "average",
      aggregate_property: "Amount",
      stack_by: "Done",
    });
    expect(averageStack.text).toMatch(/stack_by only applies to bar and horizontal_bar charts/);
    expect(databases.addView).not.toHaveBeenCalled();

    databases.addView.mockResolvedValue({ id: "view-c", name: "Spend", type: "chart", config: { groupBy: "prop-status" } });
    const r = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "Spend",
      type: "chart",
      chart_type: "horizontal_bar",
      aggregate: "sum",
      aggregate_property: "Amount",
      stack_by: "Done",
      chart_sort: "value_desc",
      show_values: true,
    });
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-c", {
      config: {
        groupBy: "prop-status",
        chartType: "horizontal_bar",
        chartAggregate: { fn: "sum", propertyId: "prop-amount" },
        stackBy: "prop-done",
        chartSort: "value_desc",
        showValues: true,
      },
    });
    expect(r.data).toMatchObject({
      type: "chart",
      group_by: "Status",
      chart_type: "horizontal_bar",
      aggregate: "sum",
      aggregate_property: "Amount",
      stack_by: "Done",
      chart_sort: "value_desc",
      show_values: true,
    });
  });

  it("updates a chart's calculation one part at a time and goes back to counting rows", async () => {
    const amount = { id: "prop-amount", name: "Amount", type: "number", options: {} };
    const views = [
      { id: "view-c", name: "Spend", type: "chart", config: { groupBy: "prop-status", chartAggregate: { fn: "sum", propertyId: "prop-amount" } } },
    ];
    databases.getDatabase.mockResolvedValue({ ...database, properties: [status, notes, amount], views });
    await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-c", aggregate: "median" });
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-c", {
      config: { groupBy: "prop-status", chartAggregate: { fn: "median", propertyId: "prop-amount" } },
    });
    const r = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-c", aggregate: "count", chart_type: "donut" });
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-c", {
      config: { groupBy: "prop-status", chartAggregate: undefined, chartType: "donut" },
    });
    expect(r.data).toMatchObject({ chart_type: "donut", aggregate: "count", show_legend: true });
    expect(r.data).not.toHaveProperty("aggregate_property");
    const ungrouped = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-c", group_by: null });
    expect(ungrouped.text).toMatch(/Charts always group/);
  });

  it("returns what a chart view plots with its rows", async () => {
    const views = [{ id: "view-c", name: "Chart", type: "chart", config: { groupBy: "prop-status", filters: [] } }];
    databases.getDatabase.mockResolvedValue({ ...database, views });
    databases.listRows.mockResolvedValue([
      { id: "r1", title: "A", properties: { "prop-status": "opt-done" } },
      { id: "r2", title: "B", properties: { "prop-status": "opt-done" } },
      { id: "r3", title: "C", properties: {} },
    ]);
    const r = await callTool(reader, "query_database", { database_id: "db-1", view_id: "view-c", limit: 1 });
    expect(r.data.returned).toBe(1);
    expect(r.data.chart).toMatchObject({
      chart_type: "bar",
      aggregate: "count",
      group_by: "Status",
      format: "number",
      series: [
        { group: "Todo", value: 0, row_count: 0 },
        { group: "Done", value: 2, row_count: 2 },
        { group: "No Status", value: 1, row_count: 1 },
      ],
    });
  });

  it("sets running totals only where they apply, and returns them with each period's own value", async () => {
    const finished = { id: "prop-finished", name: "Finished", type: "date", options: {} };
    const done = { id: "prop-done", name: "Done", type: "checkbox", options: {} };
    const views = [
      { id: "view-s", name: "By status", type: "chart", config: { groupBy: "prop-status" } },
      { id: "view-b", name: "Burndown", type: "chart", config: { groupBy: "prop-finished", groupDateBy: "week", stackBy: "prop-done" } },
    ];
    databases.getDatabase.mockResolvedValue({ ...database, properties: [status, notes, finished, done], views });
    const byStatus = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-s", accumulate: "remaining" });
    expect(byStatus.text).toMatch(/accumulate only applies to bar, horizontal_bar and line charts grouped by a date/);
    const donut = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-b", accumulate: "cumulative", chart_type: "donut" });
    expect(donut.text).toMatch(/accumulate only applies/);
    const stacked = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-b", accumulate: "remaining", stack_by: "Done" });
    expect(stacked.text).toMatch(/Running totals aren't stacked/);
    expect(databases.updateView).not.toHaveBeenCalled();

    const r = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-b", accumulate: "remaining", chart_type: "line" });
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-b", {
      config: { groupBy: "prop-finished", groupDateBy: "week", stackBy: "prop-done", chartAccumulate: "remaining", chartType: "line" },
    });
    expect(r.data).toMatchObject({ accumulate: "remaining", chart_sort: "group" });
    expect(r.data).not.toHaveProperty("stack_by");
    const off = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-b", accumulate: "none" });
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-b", { config: expect.objectContaining({ chartAccumulate: undefined }) });
    expect(off.data).not.toHaveProperty("accumulate");
    const onTable = await callTool(writer, "create_database_view", { database_id: "db-1", name: "T", type: "table", accumulate: "cumulative" });
    expect(onTable.text).toMatch(/accumulate only applies to chart views/);

    databases.getDatabase.mockResolvedValue({
      ...database,
      properties: [status, notes, finished, done],
      views: [{ id: "view-b", name: "Burndown", type: "chart", config: { groupBy: "prop-finished", groupDateBy: "week", chartAccumulate: "remaining" } }],
    });
    databases.listRows.mockResolvedValue([
      { id: "r1", title: "A", properties: { "prop-finished": "2026-09-01" } },
      { id: "r2", title: "B", properties: { "prop-finished": "2026-09-16" } },
      { id: "r3", title: "C", properties: {} },
    ]);
    const q = await callTool(reader, "query_database", { database_id: "db-1", view_id: "view-b" });
    expect(q.data.chart).toMatchObject({
      accumulate: "remaining",
      total: 3,
      series: [
        { start: "2026-08-31", value: 2, row_count: 2, period_value: 1 },
        { start: "2026-09-07", value: 2, row_count: 2, period_value: 0 },
        { start: "2026-09-14", value: 1, row_count: 1, period_value: 1 },
      ],
    });
  });

  it("creates calendar views on a date property only", async () => {
    const due = { id: "prop-due", name: "Due", type: "date", options: {} };
    databases.getDatabase.mockResolvedValue({ ...database, properties: [status, notes, due] });
    const wrong = await callTool(writer, "create_database_view", { database_id: "db-1", name: "Cal", type: "calendar", date_by: "Notes" });
    expect(wrong.text).toMatch(/date property/);
    const onBoard = await callTool(writer, "create_database_view", { database_id: "db-1", name: "B", type: "board", date_by: "Due" });
    expect(onBoard.text).toMatch(/only applies to calendar/);
    expect(databases.addView).not.toHaveBeenCalled();
    databases.addView.mockResolvedValue({ id: "view-3", name: "Cal", type: "calendar", config: { dateBy: "prop-due" } });
    const r = await callTool(writer, "create_database_view", { database_id: "db-1", name: "Cal", type: "calendar" });
    expect(databases.addView).toHaveBeenCalledWith("user-1", "db-1", { name: "Cal", type: "calendar" });
    expect(r.data).toMatchObject({ type: "calendar", date_by: "Due" });
  });
});

describe("create_database_rows", () => {
  it("adds the rows in one call and writes their bodies", async () => {
    databases.createRows.mockResolvedValue([
      { id: "row-1", title: "Acme" },
      { id: "row-2", title: "Globex" },
    ]);
    const rows = [
      { title: "Acme", properties: { Status: "Todo" }, markdown: "# Notes" },
      { title: "Globex", properties: { Status: "Done" } },
    ];
    const r = await callTool(writer, "create_database_rows", { database_id: "db-1", rows });
    expect(r.isError).toBe(false);
    expect(databases.createRows).toHaveBeenCalledWith("user-1", "db-1", rows);
    expect(collab.replaceContent).toHaveBeenCalledTimes(1);
    expect(collab.replaceContent).toHaveBeenCalledWith("row-1", "# Notes", { userId: "user-1", oauthClientId: "client-1" });
    expect(r.data).toMatchObject({
      created: 2,
      rows: [
        { id: "row-1", title: "Acme", url: "http://localhost:3000/w/ws-1/p/row-1" },
        { id: "row-2", title: "Globex" },
      ],
    });
  });

  it("refuses read-only tokens, empty and oversized batches", async () => {
    const readOnly = await callTool(reader, "create_database_rows", { database_id: "db-1", rows: [{ title: "A" }] });
    expect(readOnly.text).toMatch(/read-only/);
    const empty = await callTool(writer, "create_database_rows", { database_id: "db-1", rows: [] });
    expect(empty.isError).toBe(true);
    const rows = Array.from({ length: 101 }, (_, i) => ({ title: `Row ${i}` }));
    const tooMany = await callTool(writer, "create_database_rows", { database_id: "db-1", rows });
    expect(tooMany.isError).toBe(true);
    expect(databases.createRows).not.toHaveBeenCalled();
  });
});

describe("update_database_rows", () => {
  it("sets the values on every row and lists the rows it skipped", async () => {
    databases.updateRowsProperties.mockResolvedValue({ done: ["row-1"], skipped: ["row-2"] });
    const r = await callTool(writer, "update_database_rows", {
      database_id: "db-1",
      row_ids: ["row-1", "row-2"],
      properties: { Status: "Done" },
    });
    expect(r.isError).toBe(false);
    expect(databases.updateRowsProperties).toHaveBeenCalledWith("user-1", "db-1", ["row-1", "row-2"], { Status: "Done" });
    expect(r.data).toMatchObject({ updated: 1, skipped_row_ids: ["row-2"], url: "http://localhost:3000/w/ws-1/p/db-1" });
  });

  it("leaves skipped_row_ids out when every row changed", async () => {
    databases.updateRowsProperties.mockResolvedValue({ done: ["row-1"], skipped: [] });
    const r = await callTool(writer, "update_database_rows", { database_id: "db-1", row_ids: ["row-1"], properties: { Notes: null } });
    expect(r.data).toEqual({ database_id: "db-1", updated: 1, url: "http://localhost:3000/w/ws-1/p/db-1" });
  });

  it("refuses read-only tokens, empty changes, trashed databases and oversized batches", async () => {
    const readOnly = await callTool(reader, "update_database_rows", { database_id: "db-1", row_ids: ["r"], properties: { Status: "Done" } });
    expect(readOnly.text).toMatch(/read-only/);
    const empty = await callTool(writer, "update_database_rows", { database_id: "db-1", row_ids: ["r"], properties: {} });
    expect(empty.text).toMatch(/at least one property/);
    const tooMany = await callTool(writer, "update_database_rows", {
      database_id: "db-1",
      row_ids: Array.from({ length: 101 }, (_, i) => `row-${i}`),
      properties: { Status: "Done" },
    });
    expect(tooMany.isError).toBe(true);
    databases.getDatabase.mockResolvedValue({ ...database, database: { ...database.database, archivedAt: new Date() } });
    const trashed = await callTool(writer, "update_database_rows", { database_id: "db-1", row_ids: ["r"], properties: { Status: "Done" } });
    expect(trashed.text).toMatch(/trash/);
    expect(databases.updateRowsProperties).not.toHaveBeenCalled();
  });
});

describe("database views", () => {
  it("validates board grouping before creating the view", async () => {
    const r = await callTool(writer, "create_database_view", { database_id: "db-1", name: "By notes", type: "board", group_by: "Notes" });
    expect(r.text).toMatch(/Views group by a select, status, multi_select, .* or relation property; "Notes" is text/);
    expect(databases.addView).not.toHaveBeenCalled();
  });

  it("groups tables by date with a bucket size, and ungroups them", async () => {
    const due = { id: "prop-due", name: "Due", type: "date", options: {} };
    databases.getDatabase.mockResolvedValue({ ...database, properties: [status, notes, due] });
    const onCalendar = await callTool(writer, "create_database_view", { database_id: "db-1", name: "C", type: "calendar", group_by: "Due" });
    expect(onCalendar.text).toMatch(/only applies to board, table, timeline and chart/);
    const wrongProp = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "T",
      group_by: "Status",
      group_date_by: "week",
    });
    expect(wrongProp.text).toMatch(/group_date_by only applies when grouping by a date/);
    const ungroupBoard = await callTool(writer, "create_database_view", { database_id: "db-1", name: "B", type: "board", group_by: null });
    expect(ungroupBoard.isError).toBe(true);
    expect(databases.addView).not.toHaveBeenCalled();

    databases.addView.mockResolvedValue({ id: "view-4", name: "By week", type: "table", config: {} });
    const r = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "By week",
      group_by: "Due",
      group_date_by: "week",
      hide_empty_groups: true,
    });
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-4", {
      config: { groupBy: "prop-due", groupDateBy: "week", hideEmptyGroups: true },
    });
    expect(r.data).toMatchObject({ type: "table", group_by: "Due", group_date_by: "week", hide_empty_groups: true });

    databases.getDatabase.mockResolvedValue({
      ...database,
      properties: [status, notes, due],
      views: [{ id: "view-4", name: "By week", type: "table", config: { groupBy: "prop-due", groupDateBy: "week" } }],
    });
    const cleared = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-4", group_by: null });
    expect(cleared.isError).toBe(false);
    expect(cleared.data.group_by).toBeUndefined();
    expect(databases.updateView).toHaveBeenLastCalledWith("user-1", "view-4", { config: { groupDateBy: "week" } });
  });

  it("creates a view with filters stored as option ids", async () => {
    databases.addView.mockResolvedValue({ id: "view-2", name: "Open", type: "table", config: {} });
    const r = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "Open",
      filters: [{ property: "Status", op: "not_equals", value: "done" }],
    });
    expect(databases.addView).toHaveBeenCalledWith("user-1", "db-1", { name: "Open", type: "table" });
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-2", {
      config: { filters: [{ propertyId: "prop-status", op: "not_equals", value: "opt-done" }] },
    });
    expect(r.data.filters).toEqual([{ property: "Status", op: "not_equals", value: "Done" }]);
  });

  it("replaces only the settings it is given", async () => {
    await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-1", sorts: [] });
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-1", { config: { groupBy: "prop-status", sorts: [] } });
  });

  it("rejects unknown view ids", async () => {
    const r = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "nope", name: "X" });
    expect(r.text).toMatch(/No view with id/);
  });

  describe("moving a view's tab", () => {
    const table = { id: "view-2", name: "Table", type: "table", config: {} };
    beforeEach(() => databases.getDatabase.mockResolvedValue({ ...database, views: [...database.views, table] }));

    it("moves it before or after another view without touching its settings", async () => {
      const before = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-2", before_view_id: "view-1" });
      expect(before.isError).toBe(false);
      expect(databases.moveView).toHaveBeenLastCalledWith("user-1", "view-2", "view-1", "before");
      await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-1", after_view_id: "view-2" });
      expect(databases.moveView).toHaveBeenLastCalledWith("user-1", "view-1", "view-2", "after");
      expect(databases.updateView).not.toHaveBeenCalled();
    });

    it("moves it before saving other changes", async () => {
      await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-2", before_view_id: "view-1", name: "First" });
      expect(databases.moveView.mock.invocationCallOrder[0]).toBeLessThan(databases.updateView.mock.invocationCallOrder[0]);
    });

    it("rejects both sides, itself and views of other databases", async () => {
      const both = { database_id: "db-1", view_id: "view-2", before_view_id: "view-1", after_view_id: "view-1" };
      expect((await callTool(writer, "update_database_view", both)).text).toMatch(/not both/);
      const self = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-2", after_view_id: "view-2" });
      expect(self.text).toMatch(/No other view/);
      const other = await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-2", after_view_id: "view-9" });
      expect(other.text).toMatch(/No other view/);
      expect(databases.moveView).not.toHaveBeenCalled();
    });
  });
});

describe("filter groups over MCP", () => {
  const done = { propertyId: "prop-status", op: "equals", value: "opt-done" };
  const todo = { propertyId: "prop-status", op: "equals", value: "opt-todo" };
  const noNotes = { propertyId: "prop-notes", op: "is_empty" };

  it("stores groups and the top-level combinator of a new view", async () => {
    databases.addView.mockResolvedValue({ id: "view-2", name: "Either", type: "table", config: {} });
    const r = await callTool(writer, "create_database_view", {
      database_id: "db-1",
      name: "Either",
      filter_combinator: "or",
      filters: [
        { property: "Status", op: "equals", value: "Done" },
        {
          type: "group",
          combinator: "and",
          rules: [
            { property: "Status", op: "equals", value: "Todo" },
            { type: "group", combinator: "or", rules: [{ property: "Notes", op: "is_empty" }] },
          ],
        },
      ],
    });
    expect(r.isError).toBe(false);
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-2", {
      config: {
        filterCombinator: "or",
        filters: [done, { type: "group", combinator: "and", rules: [todo, { type: "group", combinator: "or", rules: [noNotes] }] }],
      },
    });
    expect(r.data.filter_combinator).toBe("or");
    expect(r.data.filters[1]).toEqual({
      type: "group",
      combinator: "and",
      rules: [
        { property: "Status", op: "equals", value: "Todo" },
        { type: "group", combinator: "or", rules: [{ property: "Notes", op: "is_empty" }] },
      ],
    });
  });

  it("rejects groups nested too deep and unknown ops with clear messages", async () => {
    const leaf = { property: "Notes", op: "is_empty" };
    const deep = await callTool(writer, "update_database_view", {
      database_id: "db-1",
      view_id: "view-1",
      filters: [{ type: "group", rules: [{ type: "group", rules: [{ type: "group", rules: [leaf] }] }] }],
    });
    expect(deep.isError).toBe(true);
    expect(deep.text).toMatch(/at most 2 levels deep/);
    const unknown = await callTool(writer, "query_database", {
      database_id: "db-1",
      filters: [{ property: "Notes", op: "matches", value: "x" }],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/filters\.0: op: Invalid option: expected one of .*"is_within"/);
    expect(databases.updateView).not.toHaveBeenCalled();
    expect(databases.listRows).not.toHaveBeenCalled();
  });

  it("switches only the combinator when that is all it is given", async () => {
    await callTool(writer, "update_database_view", { database_id: "db-1", view_id: "view-1", filter_combinator: "or" });
    expect(databases.updateView).toHaveBeenCalledWith("user-1", "view-1", {
      config: { groupBy: "prop-status", sorts: [{ propertyId: "title", direction: "asc" }], filterCombinator: "or" },
    });
  });

  it("queries with a saved view's filters and the caller's, each keeping its combinator", async () => {
    databases.getDatabase.mockResolvedValue({
      ...database,
      views: [{ id: "view-or", name: "Either", type: "table", config: { filterCombinator: "or", filters: [done, todo] } }],
    });
    databases.listRows.mockResolvedValue([]);
    await callTool(reader, "query_database", {
      database_id: "db-1",
      view_id: "view-or",
      filters: [{ property: "Notes", op: "is_empty" }],
    });
    expect(databases.listRows).toHaveBeenCalledWith("user-1", "db-1", {
      filters: [
        { type: "group", combinator: "or", rules: [done, todo] },
        { type: "group", combinator: "and", rules: [noNotes] },
      ],
      sorts: [],
    });
  });

  it("still accepts a plain list of rules", async () => {
    databases.listRows.mockResolvedValue([]);
    await callTool(reader, "query_database", {
      database_id: "db-1",
      filters: [{ property: "Status", op: "equals", value: "Done" }, { property: "Notes", op: "is_empty" }],
    });
    expect(databases.listRows).toHaveBeenCalledWith("user-1", "db-1", {
      filters: [{ type: "group", combinator: "and", rules: [done, noNotes] }],
      sorts: [],
    });
  });
});

describe("trash and history", () => {
  it("restore_page reports when the page lands at the top level", async () => {
    pages.getPage
      .mockResolvedValueOnce({ ...page, parentId: "gone", archivedAt: new Date() })
      .mockResolvedValueOnce({ ...page, parentId: null });
    const r = await callTool(writer, "restore_page", { page_id: "page-1" });
    expect(pages.restorePage).toHaveBeenCalledWith("user-1", "page-1");
    expect(r.data.note).toMatch(/top level/);
  });

  it("restore_page_version snapshots via the collab service and refuses trashed pages", async () => {
    pages.getSnapshot.mockResolvedValue({ id: "snap-1", pageId: "page-1", title: "Plan v1", contentMarkdown: "old", createdAt: new Date() });
    const ok = await callTool(writer, "restore_page_version", { version_id: "snap-1" });
    expect(pages.restoreSnapshot).toHaveBeenCalledWith({ userId: "user-1", oauthClientId: "client-1" }, "snap-1");
    expect(ok.data.url).toBe("http://localhost:3000/w/ws-1/p/page-1");

    pages.restoreSnapshot.mockClear();
    pages.getPage.mockResolvedValue({ ...page, archivedAt: new Date() });
    const trashed = await callTool(writer, "restore_page_version", { version_id: "snap-1" });
    expect(trashed.text).toMatch(/trash/);
    expect(pages.restoreSnapshot).not.toHaveBeenCalled();
  });

  it("list_page_history names the MCP client behind a change", async () => {
    pages.listSnapshots.mockResolvedValue([
      { id: "s1", title: "Plan", reason: "before_mcp_write", createdAt: new Date("2026-09-02T00:00:00Z"), authorName: "Erhan", clientName: "Claude" },
    ]);
    const r = await callTool(reader, "list_page_history", { page_id: "page-1" });
    expect(r.data.versions[0]).toMatchObject({ id: "s1", by: "Erhan via Claude", saved_at: "2026-09-02T00:00:00.000Z" });
  });

  it("diff_page_version prints the changes and who made them", async () => {
    const { diffBlocks, diffWords, flattenBlocks } = await import("@/lib/page-diff");
    const para = (text: string) => ({ type: "paragraph", props: {}, content: text });
    pageHistory.diffSnapshot.mockResolvedValue({
      against: "current",
      fromId: "s1",
      toId: null,
      title: diffWords("Plan", "Plan v2"),
      changes: diffBlocks(flattenBlocks([para("The quick fox")]), flattenBlocks([para("The slow fox"), para("New")])),
      actors: [{ name: "Erhan", client: "Claude" }],
    });
    const r = await callTool(reader, "diff_page_version", { version_id: "s1" });
    expect(pageHistory.diffSnapshot).toHaveBeenCalledWith("user-1", "s1", "current");
    expect(r.data).toMatchObject({
      from: "s1",
      to: "current",
      changed: true,
      title: "Plan{+ v2+}",
      changed_by: ["Erhan via Claude"],
      diff: "~ The [-quick-]{+slow+} fox\n+ New",
    });

    pageHistory.diffSnapshot.mockResolvedValue(null);
    const oldest = await callTool(reader, "diff_page_version", { version_id: "s1", against: "previous" });
    expect(oldest.data.note).toMatch(/oldest/);
  });
});

describe("workspace reads", () => {
  it("list_users marks the connected user and says when each joined", async () => {
    workspaces.listMembers.mockResolvedValue([
      { userId: "user-1", name: "Erhan", email: "e@example.com", role: "owner", joinedAt: new Date("2026-01-02T03:04:05Z") },
      { userId: "user-2", name: "Ada", email: "a@example.com", role: "member", joinedAt: new Date("2026-02-03T00:00:00Z") },
    ]);
    const r = await callTool(reader, "list_users", { workspace_id: "ws-1" });
    expect(r.data.users.map((u: { is_you: boolean }) => u.is_you)).toEqual([true, false]);
    expect(r.data.users.map((u: { joined_at: string }) => u.joined_at)).toEqual(["2026-01-02T03:04:05.000Z", "2026-02-03T00:00:00.000Z"]);
  });
});

describe("invite_member", () => {
  it("invites through the members page's path, as the connected user, member by default", async () => {
    workspaces.addMembers.mockResolvedValue([
      { email: "new@example.com", kind: "invited", link: "http://localhost:3000/invite/tok", delivery: "sent" },
    ]);
    const r = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "New@Example.com" });
    expect(workspaces.addMembers).toHaveBeenCalledWith("user-1", "ws-1", ["New@Example.com"], "member");
    expect(r.data).toEqual({
      status: "invited",
      email: "new@example.com",
      role: "member",
      invitation_link: "http://localhost:3000/invite/tok",
      email_sent: true,
    });
  });

  it("adds someone who has an account right away, with the role asked for", async () => {
    workspaces.addMembers.mockResolvedValue([{ email: "ada@example.com", kind: "added" }]);
    const r = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "ada@example.com", role: "guest" });
    expect(workspaces.addMembers).toHaveBeenCalledWith("user-1", "ws-1", ["ada@example.com"], "guest");
    expect(r.data).toEqual({ status: "added", email: "ada@example.com", role: "guest" });
  });

  it("says to share the link when no email went out", async () => {
    workspaces.addMembers.mockResolvedValue([{ email: "x@example.com", kind: "invited", link: "http://l/invite/t", delivery: "off" }]);
    const r = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "x@example.com" });
    expect(r.data.email_sent).toBe(false);
    expect(r.data.note).toMatch(/doesn't send email/);
  });

  it("refuses whom the workspace's member policy doesn't let add people, with a message the model can act on", async () => {
    workspaces.addMembers.mockRejectedValue(new AccessError());
    const r = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "x@example.com" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Who can add members/);
  });

  it("reports a member's invitation that waits for an owner's approval", async () => {
    workspaces.addMembers.mockResolvedValue([{ email: "x@example.com", kind: "requested" }]);
    const r = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "x@example.com" });
    expect(r.isError).toBeFalsy();
    expect(r.data.status).toBe("requested");
    expect(r.data.invitation_link).toBeUndefined();
    expect(r.data.note).toMatch(/approv/);
  });

  it("reports invalid addresses and people already in the workspace", async () => {
    workspaces.addMembers.mockResolvedValue([{ email: "nope", kind: "error", code: "invalidEmail" }]);
    const invalid = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "nope" });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/valid email/);
    workspaces.addMembers.mockResolvedValue([{ email: "a@example.com", kind: "error", code: "alreadyMember" }]);
    const member = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "a@example.com" });
    expect(member.isError).toBe(true);
    expect(member.text).toMatch(/already in the workspace/);
  });

  it("needs pages:write and rejects unknown roles", async () => {
    const readOnly = await callTool(reader, "invite_member", { workspace_id: "ws-1", email: "x@example.com" });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toMatch(/read-only/);
    const badRole = await callTool(writer, "invite_member", { workspace_id: "ws-1", email: "x@example.com", role: "admin" });
    expect(badRole.isError).toBe(true);
    expect(workspaces.addMembers).not.toHaveBeenCalled();
  });
});

describe("list_notifications", () => {
  const inbox = [
    {
      id: "n-2",
      kind: "page_shared",
      workspaceId: "ws-1",
      workspaceName: "Team",
      createdAt: new Date("2026-09-02T00:00:00Z"),
      read: false,
      actorName: "Ada",
      pageId: "page-1",
      pageTitle: "Plan",
      pageIcon: null,
      databaseTitle: null,
      propertyName: null,
    },
    {
      id: "n-1",
      kind: "assignment",
      workspaceId: "ws-1",
      workspaceName: "Team",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      read: true,
      actorName: null,
      pageId: "row-1",
      pageTitle: "",
      pageIcon: null,
      databaseTitle: "Tasks",
      propertyName: "Owner",
    },
    {
      id: "n-0",
      kind: "access_request",
      workspaceId: "ws-1",
      workspaceName: "Team",
      createdAt: new Date("2026-08-31T00:00:00Z"),
      read: false,
      actorName: "Grace",
      pageId: "page-2",
      pageTitle: "Budget",
      pageIcon: null,
      databaseTitle: null,
      propertyName: null,
    },
  ];

  it("lists the inbox with a summary and link for each kind", async () => {
    notifications.listNotifications.mockResolvedValue(inbox);
    const principal = { ...reader, scopes: ["pages:read", "notifications:read"] };
    const { isError, data } = await callTool(principal, "list_notifications", { workspace_id: "ws-1", unread_only: true });
    expect(isError).toBe(false);
    expect(notifications.listNotifications).toHaveBeenCalledWith("user-1", { workspaceId: "ws-1", unreadOnly: true, limit: 20 });
    expect(data.notifications[0]).toMatchObject({
      kind: "page_shared",
      read: false,
      summary: 'Ada shared "Plan" with the user',
      url: expect.stringMatching(/\/w\/ws-1\/p\/page-1$/),
    });
    expect(data.notifications[0]).not.toHaveProperty("property");
    expect(data.notifications[1]).toMatchObject({
      kind: "assignment",
      summary: 'Someone assigned the user to "Owner" on "Untitled" in Tasks',
      database: "Tasks",
      property: "Owner",
    });
    expect(data.notifications[2]).toMatchObject({
      kind: "access_request",
      summary: expect.stringMatching(/^Grace asked for access to "Budget"/),
      url: expect.stringMatching(/\/w\/ws-1\/p\/page-2$/),
    });
  });

  it("needs the notifications:read scope", async () => {
    const { isError, text } = await callTool(writer, "list_notifications", {});
    expect(isError).toBe(true);
    expect(text).toMatch(/notifications:read/);
    expect(notifications.listNotifications).not.toHaveBeenCalled();
  });
});

describe("attach_file", () => {
  const filer: McpPrincipal = { ...writer, scopes: ["pages:read", "pages:write", "files:write"] };
  const stored = {
    id: "AbCdEfGhIjKlMnOpQrStUv_-",
    url: "/api/files/AbCdEfGhIjKlMnOpQrStUv_-",
    name: "chart.png",
    contentType: "image/png",
    size: 4,
    pageId: "page-1",
    workspaceId: "ws-1",
  };

  it("needs the files:write scope", async () => {
    const { isError, text } = await callTool(writer, "attach_file", { page_id: "page-1", url: "https://example.com/a.png" });
    expect(isError).toBe(true);
    expect(text).toMatch(/files:write/);
    expect(files.uploadFromUrl).not.toHaveBeenCalled();
  });

  it("uploads base64 data and appends an image block", async () => {
    pages.getPage.mockResolvedValue(page);
    files.uploadFile.mockResolvedValue(stored);
    const { isError, data } = await callTool(filer, "attach_file", {
      page_id: "page-1",
      base64: "data:image/png;base64,iVBORw==",
      name: "chart.png",
      caption: "Q3",
    });
    expect(isError).toBe(false);
    expect(files.uploadFile).toHaveBeenCalledWith("user-1", "page-1", expect.objectContaining({ name: "chart.png", contentType: "image/png", declaredSize: 4 }));
    expect(collab.appendBlocks).toHaveBeenCalledWith(
      "page-1",
      [{ type: "image", props: { url: stored.url, name: "chart.png", caption: "Q3" } }],
      { userId: "user-1", oauthClientId: "client-1" },
      true,
    );
    expect(data).toMatchObject({ id: stored.id, block: "image", path: stored.url, appended: true });
    expect(data.url).toMatch(/\/api\/files\/AbCdEfGhIjKlMnOpQrStUv_-$/);
  });

  it("fetches a URL and, without append, returns Markdown to place it", async () => {
    pages.getPage.mockResolvedValue(page);
    files.uploadFromUrl.mockResolvedValue({ ...stored, name: "report.pdf", contentType: "application/pdf" });
    const { isError, data } = await callTool(filer, "attach_file", { page_id: "page-1", url: "https://example.com/report.pdf", append: false });
    expect(isError).toBe(false);
    expect(files.uploadFromUrl).toHaveBeenCalledWith("user-1", "page-1", "https://example.com/report.pdf", { name: undefined, contentType: undefined });
    expect(collab.appendBlocks).not.toHaveBeenCalled();
    expect(data).toMatchObject({ block: "file", appended: false, markdown: `[report.pdf](${stored.url})` });
  });

  it("wants exactly one source, and passes on upload errors", async () => {
    pages.getPage.mockResolvedValue(page);
    expect((await callTool(filer, "attach_file", { page_id: "page-1" })).text).toMatch(/url or base64/);
    expect((await callTool(filer, "attach_file", { page_id: "page-1", base64: "!!!", name: "x.bin" })).text).toMatch(/valid base64/);
    files.uploadFromUrl.mockRejectedValue(new files.FileError("Couldn't fetch the file: that address isn't public", "fetchFailed"));
    const { isError, text } = await callTool(filer, "attach_file", { page_id: "page-1", url: "http://127.0.0.1/x" });
    expect(isError).toBe(true);
    expect(text).toMatch(/isn't public/);
  });
});

describe("links as ids", () => {
  const WS = "0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5";
  const PAGE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

  it("reads the page a pasted link points at", async () => {
    const { isError } = await callTool(reader, "get_page", { page_id: `https://leafdesk.example/w/${WS}/p/${PAGE}?view=x` });
    expect(isError).toBe(false);
    expect(pages.getPage).toHaveBeenCalledWith("user-1", PAGE);
  });

  it("takes the workspace of a link for workspace_id and leaves Markdown mentions alone", async () => {
    pages.createPage.mockResolvedValue({ ...page, id: "page-2", workspaceId: WS, teamspaceId: null });
    const markdown = `See [Plan](/w/${WS}/p/${PAGE})`;
    const { isError } = await callTool(writer, "create_page", { workspace_id: `https://leafdesk.example/w/${WS}`, title: "Notes", markdown });
    expect(isError).toBe(false);
    expect(pages.createPage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: WS, markdown }));
  });
});

describe("favorites", () => {
  it("lists the starred pages of a workspace", async () => {
    pageMeta.listFavorites.mockResolvedValue([
      { id: "page-9", title: "Roadmap", icon: null, kind: "page", teamspaceId: "ts-1", updatedAt: new Date("2026-09-02T00:00:00Z") },
    ]);
    const { data } = await callTool(reader, "list_pages", { workspace_id: "ws-1", favorites: true });
    expect(pageMeta.listFavorites).toHaveBeenCalledWith("user-1", "ws-1");
    expect(pages.listChildren).not.toHaveBeenCalled();
    expect(data.pages).toEqual([
      expect.objectContaining({ id: "page-9", title: "Roadmap", teamspace_id: "ts-1", url: expect.stringMatching(/\/w\/ws-1\/p\/page-9$/) }),
    ]);
  });

  it("refuses favorites under a parent or a teamspace", async () => {
    const r = await callTool(reader, "list_pages", { workspace_id: "ws-1", favorites: true, parent_id: "page-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/leave out parent_id and teamspace_id/);
  });

  it("says whether a page is starred", async () => {
    pageMeta.isFavorite.mockResolvedValueOnce(true);
    const { data } = await callTool(reader, "get_page", { page_id: "page-1" });
    expect(pageMeta.isFavorite).toHaveBeenCalledWith("user-1", "page-1");
    expect(data.favorite).toBe(true);
  });
});

describe("duplicate_page", () => {
  const actor = { userId: "user-1", oauthClientId: "client-1" };

  it("copies the page beside the original and names the copy", async () => {
    duplicate.duplicatePage.mockResolvedValue({ id: "page-copy", workspaceId: "ws-1" });
    pages.getPage.mockImplementation(async (_: string, id: string) =>
      id === "page-copy" ? { ...page, id, title: "Plan (copy)", teamspaceId: null } : page,
    );
    const { isError, data } = await callTool(writer, "duplicate_page", { page_id: "page-1" });
    expect(isError).toBe(false);
    expect(duplicate.duplicatePage).toHaveBeenCalledWith(actor, "page-1", " (copy)");
    expect(pages.renamePage).not.toHaveBeenCalled();
    expect(data).toMatchObject({ id: "page-copy", title: "Plan (copy)", duplicated_from: "page-1", teamspace: "Private" });
    expect(data.url).toMatch(/\/w\/ws-1\/p\/page-copy$/);
  });

  it("renames the copy when a title is given", async () => {
    duplicate.duplicatePage.mockResolvedValue({ id: "page-copy", workspaceId: "ws-1" });
    const { data } = await callTool(writer, "duplicate_page", { page_id: "page-1", title: "Plan v2" });
    expect(pages.renamePage).toHaveBeenCalledWith(actor, "page-copy", "Plan v2");
    expect(data.title).toBe("Plan v2");
  });

  it("refuses trashed pages, read-only tokens and too large trees with a reason", async () => {
    pages.getPage.mockResolvedValueOnce({ ...page, archivedAt: new Date() });
    expect((await callTool(writer, "duplicate_page", { page_id: "page-1" })).text).toMatch(/in the trash/);
    expect((await callTool(reader, "duplicate_page", { page_id: "page-1" })).text).toMatch(/read-only/);
    duplicate.duplicatePage.mockRejectedValue(new Error("Can't duplicate more than 2000 pages at once"));
    const r = await callTool(writer, "duplicate_page", { page_id: "page-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/more than 2000 pages.*smaller part/);
    expect(duplicate.duplicatePage).toHaveBeenCalledTimes(1);
  });
});

/** A one-page PDF whose text layer says `text` (xref offsets computed, so pdf.js reads it cleanly). */
function tinyPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("get_file", () => {
  const FILE_ID = "AbCdEfGhIjKlMnOpQrStUv_-";
  const stored = (over: Record<string, unknown> = {}) => ({
    id: FILE_ID,
    name: "notes.md",
    contentType: "text/markdown",
    size: 12,
    workspaceId: "ws-1",
    storageKey: `ws-1/${FILE_ID}`,
    ...over,
  });

  it("reads a text file by any of its links, as a reader", async () => {
    files.fileForApp.mockResolvedValue(stored());
    files.readStored.mockResolvedValue(Buffer.from("# Notes\nçay"));
    for (const file of [FILE_ID, `/api/files/${FILE_ID}`, `https://leafdesk.example/api/files/${FILE_ID}`]) {
      const { isError, data } = await callTool(reader, "get_file", { file });
      expect(isError).toBe(false);
      expect(data).toMatchObject({ id: FILE_ID, name: "notes.md", content_type: "text/markdown", text: "# Notes\nçay" });
      expect(data.url).toMatch(new RegExp(`/api/files/${FILE_ID}$`));
    }
    expect(files.fileForApp).toHaveBeenCalledWith("user-1", FILE_ID);
  });

  it("pages through long text with offset", async () => {
    files.fileForApp.mockResolvedValue(stored({ size: MAX_MARKDOWN_CHARS + 10 }));
    files.readStored.mockResolvedValue(Buffer.from("a".repeat(MAX_MARKDOWN_CHARS) + "b".repeat(10)));
    const first = await callTool(reader, "get_file", { file: FILE_ID });
    expect(first.data).toMatchObject({ truncated: true, total_chars: MAX_MARKDOWN_CHARS + 10 });
    expect(first.data.note).toMatch(new RegExp(`offset=${MAX_MARKDOWN_CHARS}`));
    const rest = await callTool(reader, "get_file", { file: FILE_ID, offset: MAX_MARKDOWN_CHARS });
    expect(rest.data.text).toBe("b".repeat(10));
  });

  it("returns images as image content", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    files.fileForApp.mockResolvedValue(stored({ name: "chart.png", contentType: "image/png", size: png.length }));
    files.readStored.mockResolvedValue(png);
    const { isError, data, content } = await callTool(reader, "get_file", { file: FILE_ID });
    expect(isError).toBe(false);
    expect(data).toMatchObject({ name: "chart.png", content_type: "image/png" });
    expect(content[1]).toEqual({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  });

  it("reads a PDF's text layer", async () => {
    const pdf = tinyPdf("Quote 2026-114 total 48500 EUR");
    files.fileForApp.mockResolvedValue(stored({ name: "quote.pdf", contentType: "application/pdf", size: pdf.length }));
    files.readStored.mockResolvedValue(pdf);
    const { isError, data } = await callTool(reader, "get_file", { file: FILE_ID });
    expect(isError).toBe(false);
    expect(data.pages).toBe(1);
    expect(data.text).toContain("Quote 2026-114 total 48500 EUR");
  });

  it("describes files it can't show, too large ones and unreadable PDFs without reading them", async () => {
    files.fileForApp.mockResolvedValue(stored({ name: "offer.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
    expect((await callTool(reader, "get_file", { file: FILE_ID })).data.note).toMatch(/can't show this kind/);
    files.fileForApp.mockResolvedValue(stored({ name: "big.png", contentType: "image/png", size: 6 * 1024 * 1024 }));
    expect((await callTool(reader, "get_file", { file: FILE_ID })).data.note).toMatch(/too large/);
    expect(files.readStored).not.toHaveBeenCalled();
    files.fileForApp.mockResolvedValue(stored({ name: "broken.pdf", contentType: "application/pdf" }));
    files.readStored.mockResolvedValue(Buffer.from("not a pdf"));
    expect((await callTool(reader, "get_file", { file: FILE_ID })).data.note).toMatch(/couldn't be read/);
  });

  it("refuses what isn't a file link, and files the user can't read like missing ones", async () => {
    const bad = await callTool(reader, "get_file", { file: "https://example.com/a.png" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/isn't a Leafdesk file/);
    files.fileForApp.mockResolvedValue(null);
    const hidden = await callTool(reader, "get_file", { file: FILE_ID });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toMatch(/File not found/);
    files.fileForApp.mockResolvedValue(stored());
    files.readStored.mockResolvedValue(null);
    expect((await callTool(reader, "get_file", { file: FILE_ID })).text).toMatch(/File not found/);
  });
});

describe("automations", () => {
  const view = {
    id: "auto-1",
    databaseId: "db-1",
    name: "Close out",
    enabled: true,
    trigger: { type: "property_changed", propertyId: "prop-status", to: "opt-done" },
    actions: [
      { type: "set_properties", values: { "prop-notes": "Shipped", "prop-gone": { $: "now" } } },
      { type: "notify", userIds: ["user-2"], propertyIds: [] },
      { type: "webhook", url: "https://hooks.example.com/leafdesk" },
    ],
    runAs: { id: "user-1", name: "Erhan" },
    secret: "whsec_abc",
    lastRun: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };

  beforeEach(() => {
    workspaces.workspacePeople.mockResolvedValue([{ id: "user-2", name: "Ada", email: "ada@example.com", image: null, role: "member" }] as never);
  });

  it("registers the reads as read-only and the writes as writes, with their input schemas", async () => {
    const tools = new Map((await listTools(writer)).map((t) => [t.name, t]));
    for (const name of ["list_automations", "list_automation_runs"]) expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["create_automation", "update_automation", "delete_automation"]) {
      expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(tools.get("delete_automation")?.annotations?.destructiveHint).toBe(true);
    expect(tools.get("create_automation")?.annotations?.destructiveHint).toBe(false);
    const create = tools.get("create_automation")!.inputSchema;
    expect(create.required).toEqual(expect.arrayContaining(["database_id", "name", "trigger", "actions"]));
    expect(JSON.stringify(create.properties.trigger)).toMatch(/property_changed/);
    expect(JSON.stringify(create.properties.actions)).toMatch(/webhook/);
    expect(tools.get("update_automation")!.inputSchema.required).toEqual(["automation_id"]);
  });

  it("passes create input through by name and describes the result with names", async () => {
    automations.createAutomation.mockResolvedValue(view);
    const actions = [
      { type: "set_properties", values: { Notes: "Shipped", Due: { $: "now" } } },
      { type: "notify", people: ["me", "ada@example.com"] },
      { type: "webhook", url: "https://hooks.example.com/leafdesk" },
    ];
    const { isError, data } = await callTool(writer, "create_automation", {
      database_id: "https://leafdesk.example/w/0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5/p/9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
      name: "Close out",
      trigger: { type: "property_changed", property: "Status", to: "Done" },
      actions,
    });
    expect(isError).toBe(false);
    expect(automations.createAutomation).toHaveBeenCalledWith("user-1", "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", {
      name: "Close out",
      trigger: { type: "property_changed", property: "Status", to: "Done" },
      actions: [actions[0], { type: "notify", people: ["me", "ada@example.com"], properties: [] }, actions[2]],
    });
    expect(data.trigger).toMatchObject({
      property: { id: "prop-status", name: "Status" },
      to: "Done",
      summary: 'When "Status" changes to "Done"',
    });
    expect(data.actions[0].values).toEqual({ Notes: "Shipped", "prop-gone": { $: "now" } });
    expect(data.actions[1].people).toEqual([{ id: "user-2", name: "Ada" }]);
    expect(data.actions[2]).toMatchObject({ type: "webhook", url: "https://hooks.example.com/leafdesk" });
    expect(data).toMatchObject({
      webhook_secret: "whsec_abc",
      run_as: { id: "user-1", name: "Erhan" },
      url: expect.stringMatching(/\/w\/ws-1\/p\/db-1$/),
    });
  });

  it("leaves property out for any-property triggers; update patches only what is given", async () => {
    automations.createAutomation.mockResolvedValue({ ...view, trigger: { type: "property_changed", propertyId: null }, secret: null });
    const created = await callTool(writer, "create_automation", {
      database_id: "db-1",
      name: "Any change",
      enabled: false,
      trigger: { type: "property_changed" },
      actions: [{ type: "notify", properties: ["Owner"] }],
    });
    expect(automations.createAutomation.mock.calls[0][2]).toEqual({
      name: "Any change",
      enabled: false,
      trigger: { type: "property_changed", property: null },
      actions: [{ type: "notify", people: [], properties: ["Owner"] }],
    });
    expect(created.data).not.toHaveProperty("webhook_secret");
    expect(created.data.trigger.summary).toBe("When any property of a row changes");

    automations.updateAutomation.mockResolvedValue({ ...view, enabled: false });
    const updated = await callTool(writer, "update_automation", { automation_id: "auto-1", enabled: false });
    expect(updated.isError).toBe(false);
    expect(automations.updateAutomation).toHaveBeenCalledWith("user-1", "auto-1", { enabled: false });
    const empty = await callTool(writer, "update_automation", { automation_id: "auto-1" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/Nothing to change/);
  });

  it("refuses writes on read-only connections and turns automation errors into tool errors", async () => {
    const readOnly = await callTool(reader, "create_automation", {
      database_id: "db-1",
      name: "x",
      trigger: { type: "row_created" },
      actions: [{ type: "webhook", url: "https://example.com" }],
    });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toMatch(/pages:write/);
    expect(automations.createAutomation).not.toHaveBeenCalled();

    automations.createAutomation.mockRejectedValue(
      new PropertyValueError('Unknown property "Stage". Available: Status (select)', "unknownProperty"),
    );
    const unknown = await callTool(writer, "create_automation", {
      database_id: "db-1",
      name: "x",
      trigger: { type: "property_changed", property: "Stage" },
      actions: [{ type: "notify", people: ["me"] }],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/Unknown property "Stage"/);

    automations.createAutomation.mockRejectedValue(
      new PropertyValueError("Webhooks can't go to private or local addresses (10.0.0.5)", "webhookBlocked"),
    );
    const blocked = await callTool(writer, "create_automation", {
      database_id: "db-1",
      name: "x",
      trigger: { type: "row_created" },
      actions: [{ type: "webhook", url: "http://10.0.0.5/hook" }],
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/AUTOMATION_WEBHOOK_ALLOWED_HOSTS/);

    automations.deleteAutomation.mockRejectedValue(
      new PropertyValueError("No automation with this id", "invalidAutomation", { reason: "notFound" }),
    );
    const missing = await callTool(writer, "delete_automation", { automation_id: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/list_automations/);
  });

  it("lists automations and their runs on read-only connections", async () => {
    automations.listAutomations.mockResolvedValue([view]);
    const list = await callTool(reader, "list_automations", { database_id: "db-1" });
    expect(list.isError).toBe(false);
    expect(automations.listAutomations).toHaveBeenCalledWith("user-1", "db-1");
    expect(list.data.automations[0].actions.map((a: { summary: string }) => a.summary)).toEqual([
      'Set "Notes" to "Shipped", "prop-gone" to the day it runs',
      "Notify Ada",
      "POST the row to https://hooks.example.com/leafdesk",
    ]);

    automations.listAutomationRuns.mockResolvedValue([
      {
        id: "run-1",
        rowId: "row-1",
        rowTitle: "Fix login",
        event: "row.updated",
        status: "failed",
        steps: [{ type: "webhook", status: "failed", attempts: 5, code: "http", error: "Answered 500", httpStatus: 500 }],
        createdAt: "2026-10-01T00:00:00.000Z",
        finishedAt: "2026-10-01T03:00:00.000Z",
      },
    ]);
    const runs = await callTool(reader, "list_automation_runs", { automation_id: "auto-1", limit: 5 });
    expect(runs.isError).toBe(false);
    expect(automations.listAutomationRuns).toHaveBeenCalledWith("user-1", "auto-1", 5);
    expect(runs.data.runs[0]).toMatchObject({
      row: { id: "row-1", title: "Fix login" },
      steps: [{ type: "webhook", status: "failed", attempts: 5, code: "http", http_status: 500 }],
    });
  });

  it("summarizes automation notifications in the inbox", async () => {
    notifications.listNotifications.mockResolvedValue([
      {
        id: "n-3",
        kind: "automation",
        workspaceId: "ws-1",
        workspaceName: "Team",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        read: false,
        actorName: "Ada",
        pageId: "row-1",
        pageTitle: "Fix login",
        pageIcon: null,
        databaseTitle: "Tasks",
        propertyName: null,
        automationName: "Close out",
      },
    ]);
    const principal = { ...reader, scopes: ["pages:read", "notifications:read"] };
    const { data } = await callTool(principal, "list_notifications", {});
    expect(data.notifications[0]).toMatchObject({
      kind: "automation",
      summary: 'Automation "Close out": Ada added or changed "Fix login" in Tasks',
      database: "Tasks",
      automation: "Close out",
    });
  });
});

describe("agents", () => {
  const agent = {
    id: "agent-1",
    workspaceId: "ws-1",
    userId: "bot-1",
    name: "Ticket router",
    icon: "🤖",
    description: "Sorts new tickets",
    instructions: "Set the priority from the ticket's text.",
    enabled: true,
    archived: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const access = {
    pages: [{ pageId: "db-1", title: "Tickets", icon: null, kind: "database", level: "edit" }],
    hidden: 1,
  };

  it("registers the reads as read-only and the writes as writes, with their input schemas", async () => {
    const tools = new Map((await listTools(writer)).map((t) => [t.name, t]));
    for (const name of ["list_agents", "get_agent", "list_agent_runs"]) expect(tools.get(name)?.annotations?.readOnlyHint).toBe(true);
    for (const name of ["create_agent", "update_agent", "archive_agent", "restore_agent", "set_agent_access"]) {
      expect(tools.get(name)?.annotations?.readOnlyHint).toBe(false);
    }
    expect(tools.get("archive_agent")?.annotations?.destructiveHint).toBe(true);
    expect(tools.get("create_agent")!.inputSchema.required).toEqual(["workspace_id", "name"]);
    expect(tools.get("update_agent")!.inputSchema.required).toEqual(["agent_id"]);
    expect(tools.get("set_agent_access")!.inputSchema.properties.level.enum).toEqual(["view", "comment", "edit", "remove"]);
    // The automation tools take the run_agent action, with the agent by id or name and a bounded task.
    const actions = JSON.stringify(tools.get("create_automation")!.inputSchema.properties.actions);
    expect(actions).toMatch(/run_agent/);
    expect(actions).toMatch(/"maxLength":2000/);
  });

  it("lists agents without their instructions, on read-only connections too", async () => {
    agents.listAgents.mockResolvedValue([agent]);
    const { isError, data } = await callTool(reader, "list_agents", { workspace_id: "ws-1", include_archived: true });
    expect(isError).toBe(false);
    expect(agents.listAgents).toHaveBeenCalledWith("user-1", "ws-1", { archived: true });
    expect(data.agents).toEqual([
      { id: "agent-1", name: "Ticket router", icon: "🤖", description: "Sorts new tickets", enabled: true, archived: false, user_id: "bot-1" },
    ]);
  });

  it("gets an agent with its instructions and the pages shared with it", async () => {
    agents.getAgent.mockResolvedValue(agent);
    agents.listAgentAccess.mockResolvedValue(access);
    const { data } = await callTool(reader, "get_agent", { agent_id: "agent-1" });
    expect(data).toMatchObject({
      id: "agent-1",
      workspace_id: "ws-1",
      instructions: "Set the priority from the ticket's text.",
      access: {
        pages: [{ page_id: "db-1", title: "Tickets", kind: "database", level: "edit", url: expect.stringMatching(/\/w\/ws-1\/p\/db-1$/) }],
        hidden: 1,
      },
    });
  });

  it("creates, changes, archives and restores agents with what was given", async () => {
    agents.createAgent.mockResolvedValue(agent);
    const created = await callTool(writer, "create_agent", { workspace_id: "ws-1", name: "Ticket router", icon: "🤖", instructions: "Be brief" });
    expect(created.isError).toBe(false);
    expect(agents.createAgent).toHaveBeenCalledWith("user-1", "ws-1", { name: "Ticket router", icon: "🤖", instructions: "Be brief" });
    expect(created.data).toMatchObject({ id: "agent-1", access: { pages: [] } });

    agents.updateAgent.mockResolvedValue({ ...agent, enabled: false, icon: null });
    const updated = await callTool(writer, "update_agent", { agent_id: "agent-1", enabled: false, icon: null });
    expect(updated.isError).toBe(false);
    expect(agents.updateAgent).toHaveBeenCalledWith("user-1", "agent-1", { enabled: false, icon: null });
    const empty = await callTool(writer, "update_agent", { agent_id: "agent-1" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/Nothing to change/);

    agents.archiveAgent.mockResolvedValue({ ...agent, archived: true, enabled: false });
    expect((await callTool(writer, "archive_agent", { agent_id: "agent-1" })).data).toMatchObject({ archived: true });
    agents.restoreAgent.mockResolvedValue({ ...agent, enabled: false });
    expect((await callTool(writer, "restore_agent", { agent_id: "agent-1" })).data).toMatchObject({ archived: false, enabled: false });
  });

  it("shares and unshares pages and returns the agent's access", async () => {
    agents.getAgent.mockResolvedValue(agent);
    agents.listAgentAccess.mockResolvedValue(access);
    const shared = await callTool(writer, "set_agent_access", { agent_id: "agent-1", page_id: "db-1", level: "comment" });
    expect(shared.isError).toBe(false);
    expect(agents.setAgentAccess).toHaveBeenCalledWith("user-1", "agent-1", "db-1", "comment");
    expect(shared.data.access.pages).toHaveLength(1);
    await callTool(writer, "set_agent_access", { agent_id: "agent-1", page_id: "db-1", level: "remove" });
    expect(agents.removeAgentAccess).toHaveBeenCalledWith("user-1", "agent-1", "db-1");
    const full = await callTool(writer, "set_agent_access", { agent_id: "agent-1", page_id: "db-1", level: "full" });
    expect(full.isError).toBe(true);
  });

  it("refuses writes on read-only connections and turns agent errors into tool errors", async () => {
    const readOnly = await callTool(reader, "create_agent", { workspace_id: "ws-1", name: "x" });
    expect(readOnly.isError).toBe(true);
    expect(readOnly.text).toMatch(/pages:write/);
    expect(agents.createAgent).not.toHaveBeenCalled();

    const cases: [string, Record<string, string>, RegExp][] = [
      ["notFound", {}, /list_agents/],
      ["archived", {}, /restore_agent/],
      ["tooMany", { max: "50" }, /at most 50 agents/],
      ["invalid", { reason: "icon" }, /one emoji/],
    ];
    for (const [code, params, message] of cases) {
      agents.updateAgent.mockRejectedValueOnce(new agents.AgentError(code, "x", params));
      const result = await callTool(writer, "update_agent", { agent_id: "agent-1", name: "y" });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(message);
    }

    agents.createAgent.mockRejectedValueOnce(new AccessError());
    const notOwner = await callTool(writer, "create_agent", { workspace_id: "ws-1", name: "x" });
    expect(notOwner.text).toMatch(/Only owners/);

    agents.setAgentAccess.mockRejectedValueOnce(new agents.AgentError("notAPage", "Page not found"));
    const notAPage = await callTool(writer, "set_agent_access", { agent_id: "agent-1", page_id: "p-x", level: "view" });
    expect(notAPage.text).toMatch(/agent's workspace/);
    agents.setAgentAccess.mockRejectedValueOnce(new AccessError());
    const notFull = await callTool(writer, "set_agent_access", { agent_id: "agent-1", page_id: "p-x", level: "view" });
    expect(notFull.text).toMatch(/needs full access/);
  });

  it("lists runs with their steps summarized and rows linked only when the user can open them", async () => {
    agents.getAgent.mockResolvedValue(agent);
    const source = { kind: "automation", automationId: "auto-1", automationRunId: "arun-1", databaseId: "db-1", rowId: "row-1" };
    agents.listAgentRuns.mockResolvedValue([
      {
        id: "run-1",
        status: "done",
        code: null,
        error: null,
        source,
        rowTitle: "Printer jammed",
        steps: [
          { kind: "search", query: "printer", results: 2 },
          { kind: "thought", text: "Hardware issue." },
          {
            kind: "write",
            action: "updateRow",
            outcome: "done",
            targetId: "row-1",
            pageId: "row-1",
            title: null,
            changes: [{ property: "Priority", value: "High" }],
          },
          { kind: "comment", pageId: "row-1", text: "Set to High.", outcome: "done" },
        ],
        answer: "Done.",
        usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.001, rounds: 3 },
        createdAt: "2026-10-01T00:00:00.000Z",
        finishedAt: "2026-10-01T00:00:10.000Z",
      },
      { id: "run-2", status: "failed", code: "aiOff", error: null, source: { ...source, rowId: "row-2" }, rowTitle: null, steps: [], answer: "", usage: null, createdAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:01.000Z" },
    ]);
    const { isError, data } = await callTool(reader, "list_agent_runs", { agent_id: "agent-1", limit: 5 });
    expect(isError).toBe(false);
    expect(agents.listAgentRuns).toHaveBeenCalledWith("user-1", "agent-1", 5);
    expect(data.runs[0]).toMatchObject({
      status: "done",
      source: { kind: "automation", automation_id: "auto-1", database_id: "db-1" },
      row: { id: "row-1", title: "Printer jammed", url: expect.stringMatching(/\/w\/ws-1\/p\/row-1$/) },
      answer: "Done.",
      usage: { rounds: 3, input_tokens: 900, output_tokens: 40 },
    });
    expect(data.runs[0].steps.map((s: { summary: string }) => s.summary)).toEqual([
      'Searched "printer" (2 results)',
      "Hardware issue.",
      'Changed the row: "Priority" to "High"',
      'Commented: "Set to High."',
    ]);
    expect(data.runs[1]).toMatchObject({ status: "failed", code: "aiOff", row: { id: "row-2", title: null } });
    expect(data.runs[1].row).not.toHaveProperty("url");
  });

  it("passes run_agent actions through and names the agent in automations", async () => {
    agents.listAgents.mockResolvedValue([agent]);
    automations.createAutomation.mockResolvedValue({
      id: "auto-1",
      databaseId: "db-1",
      name: "Route",
      enabled: true,
      trigger: { type: "row_created" },
      actions: [{ type: "run_agent", agentId: "agent-1", prompt: "Set the priority" }],
      runAs: { id: "user-1", name: "Erhan" },
      secret: null,
      lastRun: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const { isError, data } = await callTool(writer, "create_automation", {
      database_id: "db-1",
      name: "Route",
      trigger: { type: "row_created" },
      actions: [{ type: "run_agent", agent: "Ticket router", prompt: "Set the priority" }],
    });
    expect(isError).toBe(false);
    expect(automations.createAutomation.mock.calls[0][2].actions).toEqual([{ type: "run_agent", agent: "Ticket router", prompt: "Set the priority" }]);
    expect(agents.listAgents).toHaveBeenCalledWith("user-1", "ws-1", { archived: true });
    expect(data.actions[0]).toEqual({
      type: "run_agent",
      agent: { id: "agent-1", name: "Ticket router" },
      prompt: "Set the priority",
      summary: 'Run the agent "Ticket router" on the row',
    });

    const tooLong = await callTool(writer, "create_automation", {
      database_id: "db-1",
      name: "Route",
      trigger: { type: "row_created" },
      actions: [{ type: "run_agent", agent: "Ticket router", prompt: "x".repeat(2001) }],
    });
    expect(tooLong.isError).toBe(true);
  });
});
