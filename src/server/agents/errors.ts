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
  /** A correction taken back after someone changed its note (memory.ts undoAgentCorrection). */
  | "noteChanged"
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
  | "requestNotFound"
  /** A chain of agents (chains.ts) that isn't there, or that the person may not run. */
  | "chainNotFound"
  /** Run now on a chain whose run is still going. */
  | "chainRunning";

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

