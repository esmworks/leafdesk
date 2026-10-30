/** Why an agent operation (server/agents) was refused, for the app, MCP and REST to word. */
export type AgentErrorCode =
  | "invalid"
  | "notFound"
  | "tooMany"
  | "archived"
  | "notAPage"
  | "notASkill"
  | "skillEditable"
  | "tooManySkills"
  | "noteEmpty"
  | "noteTooLong"
  | "memoryFull"
  | "noteNotFound"
  | "paused"
  | "aiOff"
  | "limitReached"
  | "tooManyRuns"
  | "notARow"
  | "notADatabase"
  | "tooManySchedules"
  | "scheduleNotFound"
  | "versionNotFound"
  /** The person may see the agent, not do this with it (their level on it is too low). */
  | "notAllowed"
  /** Only the workspace's owners do this (an agent's monthly token limit, its connections' tools). */
  | "ownersOnly"
  /** An agent is shared only with the workspace's owners and members. */
  | "notAMember"
  /** A request for a higher limit that was decided already, or never was. */
  | "requestNotFound";

export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string,
    readonly params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "AgentError";
  }
}

