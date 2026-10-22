import { describe, expect, it, vi } from "vitest";
import { API_TOKEN_SCOPES } from "@/lib/api-scopes";
import { buildOpenApiDocument } from "./openapi";
import { decodeCursor, encodeCursor, nextCursor, paginate } from "./pagination";
import { API_ROUTES } from "./routes";

vi.mock("@/db", () => ({ db: {} }));

type Json = Record<string, any>;
const doc = buildOpenApiDocument(API_ROUTES, { appUrl: "https://notes.example", version: "1.0.0" }) as Json;

/** Every `$ref` in the document, with where it was found. */
function refs(node: unknown, path = "#"): [string, string][] {
  if (Array.isArray(node)) return node.flatMap((item, i) => refs(item, `${path}/${i}`));
  if (!node || typeof node !== "object") return [];
  return Object.entries(node as Json).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [[path, value] as [string, string]] : refs(value, `${path}/${key}`),
  );
}

const resolve = (pointer: string) =>
  pointer
    .slice(2)
    .split("/")
    .reduce<unknown>((node, key) => (node as Json | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);

const operations = Object.entries(doc.paths as Json).flatMap(([path, methods]) =>
  Object.entries(methods as Json).map(([method, op]) => ({ path, method, op: op as Json })),
);

describe("OpenAPI document", () => {
  it("is OpenAPI 3.1 with info, a server under /api/v1 and bearer auth", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toMatchObject({ title: expect.any(String), version: "1.0.0" });
    expect(doc.servers).toEqual([{ url: "https://notes.example/api/v1" }]);
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  });

  it("describes every route once, with a unique operationId", () => {
    expect(operations).toHaveLength(API_ROUTES.length);
    const ids = operations.map(({ op }) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const route of API_ROUTES) expect(doc.paths[route.path][route.method.toLowerCase()]).toBeDefined();
  });

  it("gives every operation a tag, a known scope and responses", () => {
    const tags = new Set((doc.tags as Json[]).map((t) => t.name));
    for (const { op } of operations) {
      expect(op.tags.every((t: string) => tags.has(t)), op.operationId).toBe(true);
      expect(op.summary, op.operationId).toBeTruthy();
      const scopes = op.security.flatMap((s: Json) => s.bearerAuth);
      expect(scopes.every((s: string) => (API_TOKEN_SCOPES as readonly string[]).includes(s)), op.operationId).toBe(true);
      // One scope each, said in the description too; only GET /me takes any token.
      expect(scopes.length, op.operationId).toBe(op.operationId === "getMe" ? 0 : 1);
      expect(op.description, op.operationId).toContain(scopes.length ? `Scope: \`${scopes[0]}\`` : "Any token");
      const codes = Object.keys(op.responses);
      expect(codes.some((c) => /^2\d\d$/.test(c)), op.operationId).toBe(true);
      expect(codes).toEqual(expect.arrayContaining(["401", "404", "429"]));
    }
  });

  it("declares exactly the path parameters each path has", () => {
    for (const { path, op } of operations) {
      const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const declared = ((op.parameters ?? []) as Json[]).filter((p) => p.in === "path");
      expect(declared.map((p) => p.name).sort(), op.operationId).toEqual(inPath);
      expect(declared.every((p) => p.required === true)).toBe(true);
    }
  });

  it("gives parameters and bodies JSON Schemas", () => {
    for (const { op } of operations) {
      for (const p of (op.parameters ?? []) as Json[]) {
        expect(["path", "query", "header"]).toContain(p.in);
        expect(p.schema, `${op.operationId} ${p.name}`).toEqual(expect.any(Object));
      }
      const body = (Object.values(op.requestBody?.content ?? {})[0] as Json | undefined)?.schema;
      if (op.requestBody) {
        expect(body?.type, op.operationId).toBe("object");
        expect(body.$schema).toBeUndefined();
      }
    }
    const create = doc.paths["/pages"].post.requestBody.content["application/json"].schema;
    expect(Object.keys(create.properties)).toEqual(expect.arrayContaining(["workspace_id", "parent_id", "title", "markdown"]));
    const query = doc.paths["/databases/{database_id}/query"].post.requestBody.content["application/json"].schema;
    expect(Object.keys(query.properties)).toEqual(expect.arrayContaining(["filters", "sorts", "limit", "cursor"]));
    expect(query.properties.database_id).toBeUndefined();
  });

  it("uses every scope, with routes of each resource", () => {
    const used = new Set(operations.flatMap(({ op }) => op.security.flatMap((s: Json) => s.bearerAuth)));
    expect([...used].sort()).toEqual([...API_TOKEN_SCOPES].sort());
    expect(doc.paths["/databases/{database_id}/query"].post["x-scope"]).toBe("rows:read");
    expect(doc.paths["/pages/{page_id}/comments"].post["x-scope"]).toBe("comments:write");
    expect(doc.paths["/workspaces"].get["x-scope"]).toBe("workspaces:read");
  });

  it("offers an Idempotency-Key on the endpoints that change something, and only those", () => {
    for (const { method, path, op } of operations) {
      const header = ((op.parameters ?? []) as Json[]).find((p) => p.in === "header" && p.name === "Idempotency-Key");
      const changes = method !== "get" && String(op["x-scope"] ?? "").endsWith(":write");
      expect(Boolean(header), `${method} ${path}`).toBe(changes);
      if (changes) expect(Object.keys(op.responses), op.operationId).toEqual(expect.arrayContaining(["409", "422"]));
    }
    expect(doc.paths["/databases/{database_id}/query"].post.parameters?.some((p: Json) => p.in === "header")).toBeFalsy();
    expect(doc.paths["/pages"].post.responses["201"].headers["Idempotent-Replayed"]).toBeDefined();
  });

  it("documents the rate limit headers on answers to tokens", () => {
    expect(doc.paths["/me"].get.responses["200"].headers).toEqual(
      expect.objectContaining({ "X-RateLimit-Limit": expect.any(Object), "X-RateLimit-Remaining": expect.any(Object), "X-RateLimit-Reset": expect.any(Object) }),
    );
    expect(doc.components.responses.E429.headers["Retry-After"]).toBeDefined();
  });

  it("describes bodies with files as multipart form data", () => {
    const op = doc.paths["/voice-notes"].post;
    const schema = op.requestBody.content["multipart/form-data"].schema;
    expect(op.requestBody.content["application/json"]).toBeUndefined();
    expect(schema.properties.audio).toMatchObject({ type: "string", format: "binary" });
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["workspace_id", "database_id"]));
    expect(schema.required).toEqual(["audio"]);
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(["201", "409", "413", "415", "502"]));
  });

  it("only refers to things it defines", () => {
    const all = refs(doc);
    expect(all.length).toBeGreaterThan(20);
    for (const [where, pointer] of all) {
      expect(pointer.startsWith("#/"), where).toBe(true);
      expect(resolve(pointer), `${where} → ${pointer}`).toBeDefined();
    }
  });

  it("serializes to JSON", () => {
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });
});

describe("cursors", () => {
  it("round-trip and refuse anything else", () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor(undefined)).toBe(0);
    for (const bad of ["nope", encodeCursor(-1), Buffer.from('{"o":1.5}').toString("base64url")]) {
      expect(() => decodeCursor(bad)).toThrow(expect.objectContaining({ code: "invalid_cursor", status: 400 }));
    }
  });

  it("page through a list and stop at the end", () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const first = paginate(items, undefined, 2);
    expect(first).toEqual({ items: [0, 1], next_cursor: encodeCursor(2), has_more: true });
    const last = paginate(items, encodeCursor(4), 2);
    expect(last).toEqual({ items: [4], next_cursor: null, has_more: false });
    expect(nextCursor(0, 5, 5)).toBeNull();
  });
});
