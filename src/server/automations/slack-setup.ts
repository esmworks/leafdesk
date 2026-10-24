import { TO_VALUE_TYPES, UNSETTABLE_TYPES, type AutomationTrigger } from "@/lib/automations";
import type { StatusGroup } from "@/lib/property-types";
import { getProperties, requireDatabase } from "@/server/databases";
import { createAutomation, listAutomations } from "./manage";

/**
 * The quick setup of Slack notifications in a database's menu: it makes an ordinary automation
 * ("a row is added" or "a property changes (to a value)", then "Send to Slack"), which the
 * automations dialog shows and changes like any other. Full access to the database, as automations.
 */

/** A property a notification can watch; options for those that can change to one. */
export type SlackWatchable = {
  id: string;
  name: string;
  type: string;
  options: { id: string; name: string; group?: StatusGroup }[];
};

export type SlackSetup = {
  properties: SlackWatchable[];
  /** The database's automations that send to Slack. */
  automations: { id: string; name: string; enabled: boolean; trigger: AutomationTrigger; hints: string[] }[];
};

export async function slackSetup(userId: string, databaseId: string): Promise<SlackSetup> {
  await requireDatabase(userId, databaseId, "full");
  const [props, automations] = await Promise.all([getProperties(databaseId), listAutomations(userId, databaseId)]);
  return {
    properties: props
      .filter((p) => !(UNSETTABLE_TYPES as readonly string[]).includes(p.type))
      .map((p) => ({
        id: p.id,
        name: p.name,
        type: p.type,
        options:
          p.type === "select" || p.type === "status" || p.type === "multi_select" ? (p.options.options ?? []).map((o) => ({ id: o.id, name: o.name, group: o.group })) : [],
      })),
    automations: automations.flatMap((a) => {
      const hints = (a.draft?.actions ?? a.actions).flatMap((x) => (x.type === "slack" ? [x.hint] : []));
      return hints.length ? [{ id: a.id, name: a.name, enabled: a.enabled, trigger: a.trigger, hints }] : [];
    }),
  };
}

export type SlackQuickInput = {
  name: string;
  url: string;
  message: string;
  /** "row_created", or a property's id: when it changes (to `to`, an option id or true/false, when given). */
  when: string;
  to?: string | boolean | null;
  timeZone?: string;
};

/** Makes the automation, published at once. */
export async function createSlackAutomation(userId: string, databaseId: string, input: SlackQuickInput) {
  const changed = input.when !== "row_created";
  const to = changed && input.to !== undefined && input.to !== null && input.to !== "" ? input.to : undefined;
  const props = changed ? await getProperties(databaseId) : [];
  const watched = props.find((p) => p.id === input.when);
  return createAutomation(userId, databaseId, {
    name: input.name,
    timeZone: input.timeZone,
    trigger: changed
      ? { type: "property_changed", property: input.when, ...(to !== undefined && watched && (TO_VALUE_TYPES as readonly string[]).includes(watched.type) ? { to } : {}) }
      : { type: "row_created" },
    actions: [{ type: "slack", url: input.url, message: input.message }],
  });
}
