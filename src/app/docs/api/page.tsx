import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { openApiDocument } from "@/server/api";
import { API_ERROR_CODES } from "@/server/api/errors";

/**
 * Reference for the REST API, rendered from the same OpenAPI document clients download from
 * /api/v1/openapi.json. Public, like the document: it describes the API, not anyone's data.
 */

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("apiTokens.docsPage");
  return { title: t("metaTitle") };
}

type Schema = {
  type?: string | string[];
  enum?: unknown[];
  items?: Schema;
  anyOf?: Schema[];
  properties?: Record<string, Schema>;
  required?: string[];
  format?: string;
  description?: string;
  default?: unknown;
  $ref?: string;
  minimum?: number;
  maximum?: number;
};
type Parameter = { name: string; in: string; required?: boolean; schema: Schema; description?: string };
type Operation = {
  operationId: string;
  tags: string[];
  summary: string;
  description?: string;
  security: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { $ref?: string; description?: string; content?: { "application/json": { schema: Schema } } }>;
};
type Doc = {
  info: { title: string; description: string };
  servers: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: { bearerAuth: { "x-scopes"?: Record<string, string> } };
  };
};

const PARAMETER_PLACES = { path: "inPath", query: "inQuery", header: "inHeader" } as const;

/** `code` and **bold** in the document's descriptions. */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code key={i} className="rounded bg-bg-hover px-1 py-px text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

function typeOf(schema: Schema | undefined, schemas: Record<string, Schema>): string {
  if (!schema) return "";
  if (schema.$ref) return schema.$ref.split("/").pop() ?? "object";
  if (schema.enum) return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (schema.anyOf) return [...new Set(schema.anyOf.map((s) => typeOf(s, schemas)))].join(" | ");
  if (schema.format === "binary") return "file";
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return (
    types.map((type) => (type === "array" ? `${typeOf(schema.items, schemas) || "any"}[]` : type)).join(" | ") ||
    (schema.properties ? "object" : "any")
  );
}

function FieldTable({ rows, labels }: { rows: { name: string; type: string; required: boolean; description?: string }[]; labels: Record<string, string> }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-start text-sm">
        <thead className="bg-bg-subtle text-xs text-fg-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{labels.name}</th>
            <th className="px-3 py-2 font-medium">{labels.type}</th>
            <th className="px-3 py-2 font-medium">{labels.description}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.name} className="align-top">
              <td className="px-3 py-2 whitespace-nowrap">
                <code className="text-[0.85em]">{row.name}</code>
                {row.required && <span className="ms-1.5 text-xs text-danger">{labels.required}</span>}
              </td>
              <td className="px-3 py-2 text-xs break-words text-fg-muted">{row.type}</td>
              <td className="px-3 py-2 text-fg-muted">{row.description ? inline(row.description) : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const METHOD_COLORS: Record<string, string> = {
  get: "text-accent",
  post: "text-[var(--added-bar)]",
  patch: "text-[var(--removed-bar)]",
};

export default async function ApiDocsPage() {
  const t = await getTranslations("apiTokens.docsPage");
  const doc = openApiDocument() as Doc;
  const base = doc.servers[0].url;
  const schemas = doc.components.schemas;
  const labels = { name: t("name"), type: t("type"), description: t("description"), required: t("required") };
  const operations = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, op })),
  );
  const [intro, ...sections] = doc.info.description.split(/\n\n/);
  const scopes = Object.entries(doc.components.securitySchemes.bearerAuth["x-scopes"] ?? {});

  return (
    <div className="min-h-dvh bg-bg">
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-8 md:py-14">
        <header className="mb-10 space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight">{doc.info.title}</h1>
          <p className="text-fg-muted">{inline(intro)}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <a href="/api/v1/openapi.json" className="text-accent hover:underline">
              {t("openapi")}
            </a>
            <span className="text-fg-muted">{t("tokensWhere")}</span>
          </div>
        </header>

        <section className="mb-10 space-y-3">
          <h2 className="text-lg font-semibold">{t("quickStart")}</h2>
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg-subtle p-4 text-xs leading-relaxed">
            {`curl ${base}/workspaces \\\n  -H "Authorization: Bearer $LEAFDESK_TOKEN"\n\ncurl -X POST ${base}/pages \\\n  -H "Authorization: Bearer $LEAFDESK_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d '{"workspace_id": "…", "title": "Hello", "markdown": "Written through the API."}'`}
          </pre>
          <p className="text-sm text-fg-muted">
            {t("baseUrl")}: <code className="rounded bg-bg-hover px-1 py-px text-[0.85em]">{base}</code>
          </p>
        </section>

        <section className="mb-10 space-y-3 text-sm leading-relaxed text-fg-muted">
          {sections.map((paragraph, i) => (
            <p key={i}>{inline(paragraph)}</p>
          ))}
        </section>

        {scopes.length > 0 && (
          <section className="mb-10 space-y-3" id="scopes">
            <h2 className="text-lg font-semibold">{t("scopes")}</h2>
            <FieldTable
              labels={{ ...labels, name: t("scope"), type: t("access") }}
              rows={scopes.map(([scope, description]) => ({
                name: scope,
                type: scope.endsWith(":write") ? t("write") : t("read"),
                required: false,
                description,
              }))}
            />
          </section>
        )}

        <section className="mb-12 space-y-3">
          <h2 className="text-lg font-semibold">{t("errors")}</h2>
          <FieldTable
            labels={{ ...labels, name: t("code"), type: t("status") }}
            rows={Object.entries(API_ERROR_CODES).map(([code, { status, description }]) => ({
              name: code,
              type: String(status),
              required: false,
              description,
            }))}
          />
        </section>

        <nav aria-label={t("endpoints")} className="mb-12">
          <h2 className="mb-3 text-lg font-semibold">{t("endpoints")}</h2>
          <ul className="space-y-1 text-sm">
            {operations.map(({ path, method, op }) => (
              <li key={op.operationId}>
                <a href={`#${op.operationId}`} className="flex gap-3 rounded-md px-2 py-1 hover:bg-bg-hover">
                  <span className={`w-12 shrink-0 text-xs font-semibold uppercase leading-5 ${METHOD_COLORS[method] ?? ""}`}>{method}</span>
                  <code className="min-w-0 truncate text-[0.85em] leading-5">{path}</code>
                  <span className="ms-auto hidden text-fg-muted sm:inline">{op.summary}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {doc.tags.map((tag) => {
          const inTag = operations.filter(({ op }) => op.tags.includes(tag.name));
          if (!inTag.length) return null;
          return (
            <section key={tag.name} className="mb-14">
              <h2 className="text-xl font-semibold">{tag.name}</h2>
              <p className="mt-1 mb-6 text-sm text-fg-muted">{tag.description}</p>
              <div className="space-y-10">
                {inTag.map(({ path, method, op }) => {
                  const [bodyType, bodyContent] = Object.entries(op.requestBody?.content ?? {})[0] ?? [];
                  const body = bodyContent?.schema;
                  const success = Object.entries(op.responses).find(([code]) => code.startsWith("2"));
                  const responseRef = success?.[1].content?.["application/json"].schema.$ref;
                  const responseName = responseRef?.split("/").pop();
                  const response = responseName ? schemas[responseName] : undefined;
                  return (
                    <article key={op.operationId} id={op.operationId} className="scroll-mt-6 space-y-4 border-t border-border pt-6">
                      <div>
                        <h3 className="text-base font-semibold">{op.summary}</h3>
                        <p className="mt-2 flex flex-wrap items-baseline gap-2 text-sm">
                          <span className={`text-xs font-semibold uppercase ${METHOD_COLORS[method] ?? ""}`}>{method}</span>
                          <code className="break-all">{path}</code>
                        </p>
                      </div>
                      {op.description && (
                        <div className="space-y-2 text-sm text-fg-muted">
                          {op.description.split(/\n\n/).map((p, i) => (
                            <p key={i}>{inline(p)}</p>
                          ))}
                        </div>
                      )}
                      {op.parameters?.length ? (
                        <div className="space-y-2">
                          <h4 className="text-sm font-medium">{t("parameters")}</h4>
                          <FieldTable
                            labels={labels}
                            rows={op.parameters.map((p) => ({
                              name: p.name,
                              type: `${typeOf(p.schema, schemas)} · ${t(PARAMETER_PLACES[p.in as keyof typeof PARAMETER_PLACES] ?? "inQuery")}`,
                              required: Boolean(p.required),
                              description: p.description,
                            }))}
                          />
                        </div>
                      ) : null}
                      {body?.properties && (
                        <div className="space-y-2">
                          <h4 className="text-sm font-medium">{bodyType === "multipart/form-data" ? t("formBody") : t("body")}</h4>
                          <FieldTable
                            labels={labels}
                            rows={Object.entries(body.properties).map(([name, schema]) => ({
                              name,
                              type: typeOf(schema, schemas),
                              required: body.required?.includes(name) ?? false,
                              description: schema.description,
                            }))}
                          />
                        </div>
                      )}
                      {response?.properties && (
                        <div className="space-y-2">
                          <h4 className="text-sm font-medium">
                            {t("response", { status: success?.[0] ?? "200" })}
                          </h4>
                          <FieldTable
                            labels={labels}
                            rows={Object.entries(response.properties).map(([name, schema]) => ({
                              name,
                              type: typeOf(schema, schemas),
                              required: false,
                              description: schema.description,
                            }))}
                          />
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })}
      </main>
    </div>
  );
}
