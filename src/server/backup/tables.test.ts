import { describe, expect, it } from "vitest";
import { BACKED_UP, backupTables, LEFT_OUT, schemaTables } from "./tables";

describe("backup tables", () => {
  it("puts every table either in backups or among those left out", () => {
    const all = [...schemaTables().keys()];
    const unclassified = all.filter((name) => !(name in BACKED_UP) && !(name in LEFT_OUT));
    expect(unclassified).toEqual([]);
    expect(Object.keys(BACKED_UP).filter((name) => name in LEFT_OUT)).toEqual([]);
    expect([...Object.keys(BACKED_UP), ...Object.keys(LEFT_OUT)].filter((name) => !all.includes(name))).toEqual([]);
  });

  it("orders each table after the tables it points at", () => {
    const order = backupTables().map((t) => t.name);
    expect(order[0]).toBe("workspace");
    for (const t of backupTables()) {
      for (const key of t.foreignKeys) {
        if (key.table === t.name || !(key.table in BACKED_UP)) continue;
        expect(order.indexOf(key.table), `${t.name} → ${key.table}`).toBeLessThan(order.indexOf(t.name));
      }
    }
  });

  it("knows each table's key and leaves generated columns out", () => {
    for (const t of backupTables()) expect(t.primaryKey.length, t.name).toBeGreaterThan(0);
    const page = backupTables().find((t) => t.name === "page")!;
    expect(page.columns.some((c) => c.name === "search_vector")).toBe(false);
    expect(page.columns.find((c) => c.name === "ydoc")?.kind).toBe("bytes");
  });
});
