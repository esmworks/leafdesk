import { env } from "@/lib/env";
import { AccessError } from "@/server/access";

/**
 * Leafdesk on one computer for one person (LEAFDESK_LOCAL_MODE, lib/env.ts) has no one to invite,
 * no email to send and no public address: SSO, SCIM, invitations and join requests, guests and
 * publishing are hidden there, and what still reaches them is refused with this. It is an
 * AccessError, so the API answers 404, the MCP tools and the actions refuse as they do for a
 * workspace someone can't reach, and pages say not found.
 */
export class LocalModeError extends AccessError {
  constructor() {
    super("Not available when Leafdesk runs on this computer");
    this.name = "LocalModeError";
  }
}

/** Throws LocalModeError in local mode; does nothing on a server. */
export function refuseInLocalMode() {
  if (env.localMode) throw new LocalModeError();
}
