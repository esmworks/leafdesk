import * as z from "zod";
import type { AgentGrantView, ConnectionView } from "@/lib/connections";
import { AccessError, ConnectedAppReadOnlyError } from "@/server/access";
import { ConnectionError } from "@/server/connections/manage";
import { id } from "@/server/operations";
import { ToolInputError } from "./format";

/**
 * Connections over MCP: owners list a workspace's connections (never their credentials or event
 * secrets) and choose which of a connection's tools an agent may use. Adding, signing in to and
 * removing connections, and answering an agent's calls, happen in the app.
 */

export const connectionInputs = {
  list: z.object({
    workspace_id: id("workspace"),
    agent_id: z.string().optional().describe("An agent of the workspace: each connection then says which of its tools this agent may use."),
  }),
  grant: z.object({
    agent_id: id("agent"),
    connection_id: z.string().describe("The connection's id, from list_connections."),
    tools: z
      .array(z.string())
      .max(200)
      .describe("The names of the connection's tools the agent may use (as list_connections names them); this replaces the list. An empty list takes the connection from the agent."),
  }),
};

/** A connection as list_connections returns it: what it is and can do, nothing secret. */
export function describeConnection(conn: ConnectionView, grant?: AgentGrantView | null) {
  return {
    id: conn.id,
    name: conn.name,
    url: conn.url,
    sign_in: conn.authType,
    status: conn.status,
    ...(conn.status !== "ready" && conn.statusError ? { problem: conn.statusError.split(":")[0] } : {}),
    tools: conn.tools.map((t) => ({ name: t.name, title: t.title, kind: t.kind === "read" ? "reads" : "writes (each call waits for an owner's approval)" })),
    event_url: conn.eventUrl,
    event_signing: conn.eventPreset,
    ...(grant !== undefined ? { agent_tools: grant?.tools ?? [] } : {}),
  };
}

/** ConnectionError (and owners-only refusals) as errors with a next step. */
export async function withConnectionErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ConnectionError) {
      switch (error.code) {
        case "notFound":
          throw new ToolInputError(
            "No such connection or agent that the user manages: only owners of a workspace see its connections and choose its agents' tools. Call list_connections (and list_agents) with the workspace.",
          );
        case "unknownTool":
          throw new ToolInputError(`The connection has no tool "${error.params.tool ?? ""}". Call list_connections to see its tools' names.`);
        default:
          throw new ToolInputError(`${error.message}.`);
      }
    }
    if (error instanceof AccessError && !(error instanceof ConnectedAppReadOnlyError)) {
      throw new ToolInputError("Only owners of the workspace see its connections and choose which tools its agents may use.");
    }
    throw error;
  }
}
