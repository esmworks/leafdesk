import * as z from "zod";

/**
 * Documentation the MCP server gives on demand instead of in its tool list, which every client
 * sends its model at the start of every session: how page bodies are written, what property values
 * look like, the full shape of filters, view settings, dashboard widgets and automations. Each
 * topic is an MCP resource (`leafdesk://docs/<topic>`, listed and read with resources/list and
 * resources/read) and get_page reads it too, for clients that don't read resources. Tools show
 * a large input only as its outline and a pointer here (see `checked`), and check it in full
 * when they are called, so nothing is lost but the bytes.
 */

export const DOCS_PREFIX = "leafdesk://docs/";

export const DOC_TOPICS = ["markdown", "properties", "filters", "views", "pivots", "dashboards", "automations", "pdf-themes"] as const;
export type DocTopic = (typeof DOC_TOPICS)[number];

export const docUri = (topic: DocTopic) => `${DOCS_PREFIX}${topic}`;

/** A topic's text: what the resource returns and get_page shows. */
export type Doc = { title: string; description: string; text: string };

/** The topic a `leafdesk://docs/<topic>` address names, or null. */
export function docTopicOf(uri: string): DocTopic | null {
  if (!uri.startsWith(DOCS_PREFIX)) return null;
  const topic = uri.slice(DOCS_PREFIX.length).replace(/\/+$/, "");
  return (DOC_TOPICS as readonly string[]).includes(topic) ? (topic as DocTopic) : null;
}

/**
 * An input a tool's list entry shows only as its outline (a list of objects, or an object) with
 * `description` (which should name its docs topic), and checks against `strict` when the tool is
 * called: what passes is `strict`'s output, and what doesn't fails with `strict`'s messages, each
 * with where in the input it is.
 */
export function checked<T extends z.ZodType>(strict: T, shape: "array" | "object", description: string) {
  const outline = shape === "array" ? z.array(z.object({}).loose()) : z.object({}).loose();
  return outline.describe(description).transform((value, ctx): z.output<T> => {
    const parsed = strict.safeParse(value);
    if (parsed.success) return parsed.data;
    for (const issue of parsed.error.issues) ctx.issues.push({ ...issue, input: value } as never);
    return z.NEVER;
  });
}

/** A schema written out for a docs topic: its JSON Schema, every field with its description. */
export function schemaText(name: string, schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return `### ${name}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
}

/** A pointer to a topic, for tool and field descriptions: "See leafdesk://docs/filters." */
export const see = (topic: DocTopic) => `See ${docUri(topic)}.`;

/**
 * Inputs with shorter descriptions for the tool list; the full ones stay with `inputs` for a docs
 * topic (see `schemaText`). Inputs `short` leaves out keep theirs.
 */
export function briefly<S extends Record<string, z.ZodType>>(inputs: S, short: Partial<Record<keyof S, string>>): S {
  return Object.fromEntries(Object.entries(inputs).map(([key, schema]) => [key, short[key] ? schema.describe(short[key]) : schema])) as S;
}
