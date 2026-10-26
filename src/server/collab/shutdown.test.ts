import { Hocuspocus } from "@hocuspocus/server";
import { describe, expect, it } from "vitest";
import { flushCollab, saveOpenDocuments } from "./shutdown";

/** A server whose saves take `saveMs` and are debounced well past the test's length. */
function serverSaving(saveMs: number) {
  const saved: string[] = [];
  const hocuspocus = new Hocuspocus({
    quiet: true,
    debounce: 60_000,
    maxDebounce: 120_000,
    extensions: [
      {
        async onStoreDocument({ documentName, document }) {
          await new Promise((resolve) => setTimeout(resolve, saveMs));
          saved.push(`${documentName}:${document.getMap("m").get("text")}`);
        },
      },
    ],
  });
  return { hocuspocus, saved };
}

async function edit(hocuspocus: Hocuspocus, name: string, text: string) {
  const connection = await hocuspocus.openDirectConnection(name);
  await connection.transact((doc) => doc.getMap("m").set("text", text));
  return connection;
}

describe("flushCollab", () => {
  it("waits until the debounced saves are written", async () => {
    const { hocuspocus, saved } = serverSaving(200);
    await edit(hocuspocus, "a", "first");
    await edit(hocuspocus, "b", "second");
    expect(saved).toEqual([]);

    expect(await flushCollab(hocuspocus, { timeoutMs: 5000 })).toBe(true);
    expect(saved.sort()).toEqual(["a:first", "b:second"]);
  });

  it("waits for a save that is already running", async () => {
    const { hocuspocus, saved } = serverSaving(300);
    await edit(hocuspocus, "a", "first");
    hocuspocus.flushPendingStores();
    expect(saved).toEqual([]);

    expect(await flushCollab(hocuspocus, { timeoutMs: 5000 })).toBe(true);
    expect(saved).toEqual(["a:first"]);
  });

  it("gives up after the timeout", async () => {
    const { hocuspocus, saved } = serverSaving(2000);
    await edit(hocuspocus, "a", "first");
    const started = Date.now();

    expect(await flushCollab(hocuspocus, { timeoutMs: 100 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(saved).toEqual([]);
  });

  it("returns at once with nothing to save", async () => {
    const { hocuspocus } = serverSaving(0);
    expect(await flushCollab(hocuspocus, { timeoutMs: 100 })).toBe(true);
  });
});

describe("saveOpenDocuments", () => {
  it("saves only the documents named, when it is given names", async () => {
    const { hocuspocus, saved } = serverSaving(50);
    await edit(hocuspocus, "page:a", "first");
    await edit(hocuspocus, "page:b", "second");

    expect(await saveOpenDocuments(hocuspocus, { timeoutMs: 5000, names: new Set(["page:a", "page:gone"]) })).toBe(true);
    expect(saved).toEqual(["page:a:first"]);
    expect(await saveOpenDocuments(hocuspocus, { timeoutMs: 5000 })).toBe(true);
    expect(saved.sort()).toEqual(["page:a:first", "page:b:second"]);
  });
});
