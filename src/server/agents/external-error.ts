/** Why an outside agent's work was refused (external.ts), for MCP and the REST API to word. A leaf, so the API's error mapping can read it. */
export type ExternalAgentErrorCode =
  /** The caller is bound to no agent, or named one it isn't bound to. */
  | "notBound"
  /** Bound to several: name one (agent_id). */
  | "ambiguous"
  /** The workspace lets connected apps only read. */
  | "readOnly"
  | "invalid"
  | "notAssigned"
  | "noMention"
  | "unknownStatus"
  | "noStatus";

export class ExternalAgentError extends Error {
  constructor(
    readonly code: ExternalAgentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ExternalAgentError";
  }
}
