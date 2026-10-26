import type { InvitationDelivery } from "@/server/workspaces";

/** The `members` text for how an invitation went out (see InvitationDelivery). */
export function deliveryText(delivery: InvitationDelivery) {
  if (delivery === "sent") return "add.emailed" as const;
  if (delivery === "failed") return "add.emailFailed" as const;
  if (delivery === "limited") return "add.emailLimited" as const;
  return "add.linkOnly" as const;
}
