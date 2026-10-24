export type GroupErrorCode = "nameRequired" | "nameTaken" | "notMember" | "ownMembership";

/** An expected failure the UI translates by `code`; the English message is for logs, MCP and the API. */
export class GroupError extends Error {
  readonly code: GroupErrorCode;

  constructor(code: GroupErrorCode, message: string) {
    super(message);
    this.name = "GroupError";
    this.code = code;
  }
}

export const MAX_GROUP_NAME = 80;

/** A group name as stored: whitespace collapsed and trimmed, at most MAX_GROUP_NAME characters. */
export function cleanGroupName(name: unknown) {
  const clean = (typeof name === "string" ? name : "").replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME).trim();
  if (!clean) throw new GroupError("nameRequired", "Give the group a name.");
  return clean;
}
