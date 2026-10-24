export type TeamspaceErrorCode =
  | "nameRequired"
  | "creationRestricted"
  | "ownersOnly"
  | "cannotLeaveDefault"
  | "lastOwner"
  | "notJoinable"
  | "archived"
  | "notMember"
  | "invalidAccess"
  | "invalidMemberLevel"
  | "invalidIcon"
  | "inGroup"
  | "everyoneIn"
  | "notConvertible";

/** An expected failure the UI translates by `code`; the English message is for logs and MCP. */
export class TeamspaceError extends Error {
  readonly code: TeamspaceErrorCode;

  constructor(code: TeamspaceErrorCode, message: string) {
    super(message);
    this.name = "TeamspaceError";
    this.code = code;
  }
}
