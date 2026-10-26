import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CutText, MAX_POSTGRES_READ, MAX_POSTGRES_ROWS, MAX_POSTGRES_TEXT, POSTGRES_DEADLINE } from "@/lib/postgres-sync";

// The server a sync reads is someone else's: it may stall, send huge values or numbers JSON can't
// hold. A fake postgres.js stands in for it.

vi.mock("@/lib/env", () => ({ env: { connectorAllowedHosts: [] } }));
vi.mock("@/server/ssrf", () => ({ isBlockedAddress: () => false }));

type Batch = Record<string, string | null>[];
const server = {
  columns: [] as { column_name: string; data_type: string }[],
  batches: [] as Batch[],
  queries: [] as string[],
  ended: [] as unknown[],
  /** The table read never answers. */
  stall: false,
};

/** postgres.js's token for stopping a cursor. */
const CLOSE = {};

function fakeSql() {
  const sql = Object.assign(
    async (strings: TemplateStringsArray) => (strings.join("?").includes("information_schema.columns") ? server.columns : [{ name: "id" }]),
    {
      begin: async (_mode: string, fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          unsafe: (query: string) => {
            server.queries.push(query);
            return Object.assign(Promise.resolve([]), {
              cursor: async (_rows: number, each: (batch: Batch) => unknown) => {
                if (server.stall) return new Promise(() => {});
                for (const batch of server.batches) if (each(batch) === CLOSE) return;
              },
            });
          },
        }),
      end: vi.fn(async (options: unknown) => void server.ended.push(options)),
      CLOSE,
    },
  );
  return sql;
}
vi.mock("postgres", () => ({ default: vi.fn(() => fakeSql()) }));

const { readTable, selectList, withPostgres } = await import("./client");

const URL = "postgres://app:pw@203.0.113.7:5432/shop";

beforeEach(() => {
  server.columns = [
    { column_name: "id", data_type: "bigint" },
    { column_name: "name", data_type: "text" },
    { column_name: "price", data_type: "numeric" },
    { column_name: "tags", data_type: "jsonb" },
  ];
  server.batches = [];
  server.queries = [];
  server.ended = [];
  server.stall = false;
});
afterEach(() => vi.useRealTimers());

describe("withPostgres", () => {
  it("cuts a server off that holds the read past the deadline", async () => {
    vi.useFakeTimers();
    server.stall = true;
    const read = withPostgres(URL, (sql) => readTable(sql, "public", "orders", "id", ["name"]));
    const failed = expect(read).rejects.toMatchObject({ code: "unreachable" });
    await vi.advanceTimersByTimeAsync(POSTGRES_DEADLINE);
    await failed;
    expect(server.ended).toContainEqual({ timeout: 0 });
  });
});

describe("readTable", () => {
  const read = () => withPostgres(URL, (sql) => readTable(sql, "public", "orders", "id", ["name", "price", "tags"]));

  it("reads every value as text, cut on the server, ordered by the table's key", async () => {
    await read();
    expect(server.queries.at(-1)).toBe(
      `select left(t."id"::text, ${MAX_POSTGRES_TEXT + 1}) as c0, left(t."name"::text, ${MAX_POSTGRES_TEXT + 1}) as c1, ` +
        `left(t."price"::text, ${MAX_POSTGRES_TEXT + 1}) as c2, left(to_json(t."tags")::text, ${MAX_POSTGRES_TEXT + 1}) as c3 ` +
        `from "public"."orders" as t order by t."id" limit ${MAX_POSTGRES_ROWS + 1}`,
    );
  });

  it("keeps big numbers exact and values past the limit cut", async () => {
    server.batches = [
      [
        { c0: "1", c1: "First", c2: "12.50", c3: '["a", "b"]' },
        { c0: "9007199254740993", c1: "x".repeat(MAX_POSTGRES_TEXT + 1), c2: "123456789012345678901234.5", c3: null },
      ],
      [{ c0: "9007199254740995", c1: null, c2: null, c3: null }],
    ];
    const rows = await read();
    expect(rows[0]).toEqual({ id: 1, name: "First", price: 12.5, tags: ["a", "b"] });
    expect(rows[1].id).toBe("9007199254740993");
    expect(rows[1].name).toEqual(new CutText("x".repeat(MAX_POSTGRES_TEXT)));
    expect(rows[1].price).toBe("123456789012345678901234.5");
    expect(rows[2].id).toBe("9007199254740995");
  });

  it("stops at too many rows", async () => {
    server.batches = [Array.from({ length: MAX_POSTGRES_ROWS + 1 }, (_, i) => ({ c0: String(i), c1: "a", c2: null, c3: null }))];
    await expect(read()).rejects.toMatchObject({ code: "tooManyIssues" });
  });

  it("stops at too much text in all", async () => {
    const row = { c0: "1", c1: "x".repeat(MAX_POSTGRES_TEXT), c2: null, c3: null };
    server.batches = Array.from({ length: Math.ceil(MAX_POSTGRES_READ / MAX_POSTGRES_TEXT / 50) + 1 }, () => Array.from({ length: 50 }, () => row));
    await expect(read()).rejects.toMatchObject({ code: "tooManyIssues" });
  });
});

describe("selectList", () => {
  it("reads checkboxes, dates and times as their JSON, and quotes names", () => {
    expect(
      selectList([
        { name: "done", kind: "checkbox" },
        { name: 'odd"name', kind: null },
      ]),
    ).toBe(`left(to_json(t."done")::text, ${MAX_POSTGRES_TEXT + 1}) as c0, left(t."odd""name"::text, ${MAX_POSTGRES_TEXT + 1}) as c1`);
  });
});
