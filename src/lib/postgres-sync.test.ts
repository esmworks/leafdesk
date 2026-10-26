import { describe, expect, it } from "vitest";
import { columnValue, kindOf, parsePostgresUrl, parseTableName, postgresSite, postgresValues } from "./postgres-sync";

describe("parsePostgresUrl", () => {
  it("reads a connection address", () => {
    expect(parsePostgresUrl("postgres://app:s%40cret@db.example.test:6543/shop?sslmode=require")).toEqual({
      host: "db.example.test",
      port: 6543,
      database: "shop",
      user: "app",
      password: "s@cret",
      sslmode: "require",
    });
    expect(parsePostgresUrl("postgresql://app@db.example.test/shop")?.port).toBe(5432);
  });

  it("refuses what isn't one", () => {
    expect(parsePostgresUrl("https://db.example.test/shop")).toBeNull();
    expect(parsePostgresUrl("postgres://db.example.test/shop")).toBeNull();
    expect(parsePostgresUrl("postgres://app@db.example.test/")).toBeNull();
    expect(parsePostgresUrl("postgres://app@db.example.test/shop?sslmode=sometimes")).toBeNull();
  });

  it("names where it reads without the user or password", () => {
    expect(postgresSite(parsePostgresUrl("postgres://app:pw@db.example.test/shop")!)).toBe("postgres://db.example.test:5432/shop");
  });
});

describe("parseTableName", () => {
  it("takes a table, with or without its schema", () => {
    expect(parseTableName("orders")).toEqual({ schema: "public", table: "orders" });
    expect(parseTableName("sales.Orders 2026")).toEqual({ schema: "sales", table: "Orders 2026" });
    expect(parseTableName("a.b.c")).toBeNull();
    expect(parseTableName('bad"name')).toBeNull();
  });
});

describe("columns", () => {
  it("become properties by their types", () => {
    expect(["integer", "numeric", "boolean", "date", "timestamp with time zone", "jsonb", "character varying", "bytea"].map(kindOf)).toEqual([
      "number",
      "number",
      "checkbox",
      "date",
      "time",
      "json",
      "text",
      null,
    ]);
  });

  it("give their values in the form their properties take", () => {
    expect(columnValue("number", "12.50")).toBe(12.5);
    expect(columnValue("time", "2026-10-26T09:00:00+03:00")).toBe("2026-10-26T06:00:00.000Z");
    expect(columnValue("time", "2026-10-26T09:00:00")).toBe("2026-10-26T09:00:00.000Z");
    expect(columnValue("json", ["a", "b"])).toBe("a, b");
    expect(columnValue("json", { a: 1 })).toBe('{"a":1}');
    expect(columnValue("text", "  ")).toBeNull();
    expect(columnValue("checkbox", false)).toBe(false);
  });

  it("write a row's values, the key as text", () => {
    const query = { schema: "public", table: "orders", keyColumn: "id", titleColumn: "name" };
    const mapping = { key: "k", columns: [{ column: "total", property: "t", kind: "number" as const }] };
    expect(postgresValues({ id: 7, name: "A", total: "9.5" }, query, mapping)).toEqual({ k: "7", t: 9.5 });
  });
});
