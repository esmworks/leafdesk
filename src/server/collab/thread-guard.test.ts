import { DefaultThreadStoreAuth } from "@blocknote/core/comments";
import { YjsThreadStore } from "@blocknote/core/yjs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { THREADS_MAP } from "@/lib/comments";
import { touchesThreads } from "./thread-guard";

/** A server document with a thread and some text, and a browser's copy of it. */
async function setup() {
  const server = new Y.Doc();
  server.getText("body").insert(0, "Hello world");
  const store = new YjsThreadStore("ann", server.getMap(THREADS_MAP), new DefaultThreadStoreAuth("ann", "editor"));
  const thread = await store.createThread({ initialComment: { body: [{ type: "paragraph", content: "hi" }] } });
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  return { server, client, thread };
}

/** What the browser would send for `change`. */
function updateFrom(client: Y.Doc, change: () => void) {
  const before = Y.encodeStateVector(client);
  change();
  return Y.encodeStateAsUpdate(client, before);
}

describe("touchesThreads", () => {
  it("lets text edits through", async () => {
    const { server, client } = await setup();
    expect(touchesThreads(server, updateFrom(client, () => client.getText("body").insert(5, ", dear")))).toBe(false);
    expect(touchesThreads(server, updateFrom(client, () => client.getText("body").delete(0, 5)))).toBe(false);
  });

  it("refuses new threads, changed comments and deletions from browsers", async () => {
    const { server, client, thread } = await setup();
    const threads = () => client.getMap<Y.Map<unknown>>(THREADS_MAP);
    expect(touchesThreads(server, updateFrom(client, () => threads().set("forged", new Y.Map())))).toBe(true);
    const comment = () => (threads().get(thread.id)!.get("comments") as Y.Array<Y.Map<unknown>>).get(0);
    expect(touchesThreads(server, updateFrom(client, () => comment().set("userId", "bob")))).toBe(true);
    expect(touchesThreads(server, updateFrom(client, () => threads().get(thread.id)!.set("resolved", true)))).toBe(true);
    expect(touchesThreads(server, updateFrom(client, () => threads().delete(thread.id)))).toBe(true);
  });

  it("refuses threads on a page that has none yet", () => {
    const server = new Y.Doc();
    const client = new Y.Doc();
    expect(touchesThreads(server, updateFrom(client, () => client.getMap(THREADS_MAP).set("t", new Y.Map())))).toBe(true);
  });

  it("lets a reconnecting browser through after the server changed a thread", async () => {
    const { server, client, thread } = await setup();
    // Resolving overwrites values in the thread, which deletes the old ones.
    const store = new YjsThreadStore("ann", server.getMap(THREADS_MAP), new DefaultThreadStoreAuth("ann", "editor"));
    await store.resolveThread({ threadId: thread.id });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server, Y.encodeStateVector(client)));
    client.getText("body").insert(5, "!");
    // What the browser answers the server's sync step 1 with: its edit and its whole delete set.
    const syncStep2 = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));
    expect(touchesThreads(server, syncStep2)).toBe(false);
  });

  it("finds a thread deletion behind garbage-collected content", async () => {
    const server = new Y.Doc();
    const gone = server.getArray<Y.Map<number>>("gone");
    const nested = new Y.Map<number>();
    gone.insert(0, [nested]);
    nested.set("a", 1);
    // Deleting the map collects what was in it: GC structs, ahead of the thread's in clock order.
    gone.delete(0, 1);
    const store = new YjsThreadStore("ann", server.getMap(THREADS_MAP), new DefaultThreadStoreAuth("ann", "editor"));
    await store.createThread({ initialComment: { body: [{ type: "paragraph", content: "hi" }] } });
    expect(server.store.clients.get(server.clientID)!.some((s) => s instanceof Y.GC)).toBe(true);
    expect(touchesThreads(server, deletions([[server.clientID, [[0, Y.getState(server.store, server.clientID)]]]]))).toBe(true);
  });

  it("refuses a huge deleted run quickly, whatever length it claims", async () => {
    const { server } = await setup();
    // One struct of client 12345: deleted content of length 4,000,000,000 at the root "blocknote".
    // Twenty-three bytes; a guard that counts through the clocks it claims never returns.
    const update = new Uint8Array([
      0x01, 0x01, 0xb9, 0x60, 0x00, 0x01, 0x01, 0x09, 0x62, 0x6c, 0x6f, 0x63, 0x6b, 0x6e, 0x6f, 0x74, 0x65, 0x80, 0xd0, 0xac,
      0xf3, 0x0e, 0x00,
    ]);
    expect(Y.decodeUpdate(update).structs[0].length).toBe(4_000_000_000);
    const started = performance.now();
    expect(touchesThreads(server, update)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("walks overlapping deletion ranges in the document's length, not theirs", async () => {
    const server = new Y.Doc();
    const body = server.getText("body");
    // 3,000 one-character items (each typed before the last, so none merge), then a thread.
    for (let i = 0; i < 3000; i++) body.insert(0, "x");
    const store = new YjsThreadStore("ann", server.getMap(THREADS_MAP), new DefaultThreadStoreAuth("ann", "editor"));
    await store.createThread({ initialComment: { body: [{ type: "paragraph", content: "hi" }] } });
    // 100,000 ranges over the body, short of the thread: each walks the whole body unless the
    // walk remembers where it got to.
    const ranges: [number, number][] = [[0, 1]];
    for (let i = 0; i < 100_000; i++) ranges.push([i % 7, 3000 - (i % 7)]);
    const started = performance.now();
    expect(touchesThreads(server, deletions([[server.clientID, ranges]]))).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
    // The same walk still sees a range that reaches the thread.
    ranges.push([2999, 10]);
    expect(touchesThreads(server, deletions([[server.clientID, ranges]]))).toBe(true);
  });
});

/** An update that only deletes these [clock, length] ranges, as a browser could send it (V1). */
function deletions(clients: [number, [number, number][]][]) {
  const bytes: number[] = [];
  const varUint = (n: number) => {
    for (; n > 0x7f; n = Math.floor(n / 128)) bytes.push((n % 128) | 0x80);
    bytes.push(n);
  };
  varUint(0); // no structs
  varUint(clients.length);
  for (const [client, ranges] of clients) {
    varUint(client);
    varUint(ranges.length);
    for (const [clock, len] of ranges) {
      varUint(clock);
      varUint(len);
    }
  }
  return new Uint8Array(bytes);
}
