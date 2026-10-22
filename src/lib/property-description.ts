/**
 * A property's description (PropertyOptions `description`): what it holds and how to fill it, in
 * plain text, for any type ("New until we've called them; Quoted once a quote is sent"). People
 * see it as a hint by the property's name and as a form question's help when the question has
 * none of its own; AI that writes values (autofill, chat, agents, MCP and the REST API) is given it
 * as guidance. Pure and client-safe.
 */

export const MAX_PROPERTY_DESCRIPTION = 1000;

/** A property's description, trimmed; "" when it has none. */
export function propertyDescription(prop: { options: { description?: unknown } }): string {
  return typeof prop.options.description === "string" ? prop.options.description.trim() : "";
}

/**
 * A description as it is stored: trimmed, with runs of blank lines folded into one; null when
 * nothing is left (the property then has none). One longer than MAX_PROPERTY_DESCRIPTION is refused.
 */
export function cleanDescription(input: string): { ok: true; description: string | null } | { ok: false } {
  const text = input.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_PROPERTY_DESCRIPTION) return { ok: false };
  return { ok: true, description: text || null };
}

/** A description on one line, for prompts and lists that give each property a line. */
export function descriptionLine(prop: { options: { description?: unknown } }): string {
  return propertyDescription(prop).replace(/\s+/g, " ");
}
