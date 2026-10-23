import type { AutomationAction, AutomationTrigger } from "./automations";

/**
 * Ready-made automations to start from in a database's automations: each is made to fit the
 * database it is used in, picking the properties it needs by type (and an option by its name),
 * and leaving empty what the database has nothing for, for the editor to fill in. Names and
 * messages are texts of the editor (`database.automations.gallery.<key>`), written in there.
 */

type GalleryProperty = { id: string; name: string; type: string; options?: { options?: { id: string; name: string }[] } };

export const GALLERY_KEYS = ["approveBeforeClosing", "notifyAssignee", "remindOverdue"] as const;
export type GalleryKey = (typeof GALLERY_KEYS)[number];

/**
 * A ready-made automation for a database: its trigger and steps by the database's property ids,
 * and `message` the step text's parts the editor writes in (templates of the properties it picked).
 */
export type GalleryAutomation = {
  key: GalleryKey;
  trigger: AutomationTrigger;
  actions: AutomationAction[];
  /** What the translated message names: the row's title as a template. */
  messageValues: { title: string };
};

const byType = (props: GalleryProperty[], ...types: string[]) => props.find((p) => types.includes(p.type));
const optionLike = (prop: GalleryProperty | undefined, pattern: RegExp) => prop?.options?.options?.find((o) => pattern.test(o.name.trim()));
/** A row's title, as a template. */
const TITLE = "{{trigger.title}}";

/** Option names a deal (or any row) is closed with, and those it asks to close with, across languages. */
const CLOSED = /^(won|approved|done|closed|kazanıldı|onaylandı|tamam|gewonnen|gagné|ganado|ganho|vinto)$/i;
const ASKING = /(review|approval|pending|negotiat|ready|onay|inceleme|müzakere)/i;

/**
 * The ready-made automations, fit to `properties` (the database's). "Ask for approval before
 * closing": when a select or status property changes to an option that asks for it (the first
 * that sounds like "in review"; any change when none does), the people of the first person
 * property approve it, then the property is set to the closing option ("Won", "Done"…).
 */
export function galleryAutomations(properties: GalleryProperty[]): GalleryAutomation[] {
  const stage = byType(properties, "status", "select");
  const person = byType(properties, "person");
  const date = byType(properties, "date");
  const status = byType(properties, "status");
  const asking = optionLike(stage, ASKING);
  const closed = optionLike(stage, CLOSED);
  const out: GalleryAutomation[] = [];

  out.push({
    key: "approveBeforeClosing",
    trigger: stage ? { type: "property_changed", propertyId: stage.id, ...(asking ? { to: asking.id } : {}) } : { type: "property_changed", propertyId: null },
    actions: [
      {
        id: "approval",
        type: "approval",
        userIds: [],
        propertyIds: person ? [person.id] : [],
        message: "",
        timeoutDays: 7,
        onTimeout: "stop",
      },
      { id: "set", type: "set_properties", values: stage && closed ? { [stage.id]: closed.id } : {} },
    ],
    messageValues: { title: TITLE },
  });

  out.push({
    key: "notifyAssignee",
    trigger: person ? { type: "property_changed", propertyId: person.id } : { type: "property_changed", propertyId: null },
    actions: [{ id: "notify", type: "notify", userIds: [], propertyIds: person ? [person.id] : [], message: "" }],
    messageValues: { title: TITLE },
  });

  out.push({
    key: "remindOverdue",
    trigger: {
      type: "date_passed",
      date: date?.id ?? "",
      days: 1,
      status: status ? { propertyId: status.id, groups: ["todo", "in_progress"] } : null,
    },
    actions: [{ id: "notify", type: "notify", userIds: [], propertyIds: person ? [person.id] : [], message: "" }],
    messageValues: { title: TITLE },
  });
  return out;
}
