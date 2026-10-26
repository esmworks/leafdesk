import { describe, expect, it } from "vitest";
import {
  columnValue,
  CutText,
  keyText,
  kindOf,
  MAX_POSTGRES_TEXT,
  numberFromText,
  parsePostgresUrl,
  parseTableName,
  postgresSite,
  postgresValues,
  readColumnValue,
} from "./postgres-sync";

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

describe("values read as text", () => {
  it("are numbers when JavaScript holds them exactly, else the server's digits", () => {
    expect(["42", "-7", "12.50", "0.0", "1e+21", "9007199254740991"].map(numberFromText)).toEqual([42, -7, 12.5, 0, 1e21, 9007199254740991]);
    expect(["9007199254740993", "-12345678901234567890", "0.12345678901234567890123", "NaN", "$1,234.50"].map(numberFromText)).toEqual([
      "9007199254740993",
      "-12345678901234567890",
      "0.12345678901234567890123",
      "NaN",
      "$1,234.50",
    ]);
  });

  it("keep big keys apart, written as JSON wrote them before", () => {
    expect(keyText(readColumnValue("number", "1272869543094706176"))).toBe("1272869543094706176");
    expect(keyText(readColumnValue("number", "1272869543094706177"))).toBe("1272869543094706177");
    expect(keyText(readColumnValue("number", "1.50"))).toBe("1.5");
    expect(columnValue("number", readColumnValue("number", "9007199254740993"))).toBe(9007199254740992);
  });

  it("read other kinds from their JSON", () => {
    expect(readColumnValue("checkbox", "true")).toBe(true);
    expect(readColumnValue("date", '"2026-10-26"')).toBe("2026-10-26");
    expect(readColumnValue("json", '{"a": 1}')).toEqual({ a: 1 });
    expect(readColumnValue("text", '{"a": 1}')).toBe('{"a": 1}');
    expect(readColumnValue("json", null)).toBeNull();
  });

  it("are cut past MAX_POSTGRES_TEXT characters", () => {
    const long = readColumnValue("json", `"${"x".repeat(MAX_POSTGRES_TEXT)}`);
    expect(long).toBeInstanceOf(CutText);
    expect(columnValue("json", long)).toBe(`"${"x".repeat(MAX_POSTGRES_TEXT - 1)}`);
    expect(columnValue("number", long)).toBeNull();
    expect(keyText(long)).toHaveLength(MAX_POSTGRES_TEXT);
    // Characters, not UTF-16 units: a text of MAX_POSTGRES_TEXT emoji is whole.
    expect(readColumnValue("text", "😀".repeat(MAX_POSTGRES_TEXT))).toBe("😀".repeat(MAX_POSTGRES_TEXT));
  });
});
