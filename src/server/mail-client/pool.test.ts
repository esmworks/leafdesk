import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/access", () => ({ AccessError: class AccessError extends Error {} }));
vi.mock("@/server/row-mail/settings", () => ({ RowMailError: class RowMailError extends Error {} }));
vi.mock("@/server/row-mail/credentials", () => ({ withMailCredentials: (_box: unknown, signedIn: (c: unknown) => Promise<unknown>) => signedIn({}) }));

/** A connection that answers, or, once `dead`, never does, until it is closed. */
class FakeClient {
  usable = true;
  mailbox: { path: string } | false = false;
  dead = false;
  closed = 0;
  private pending: ((error: Error) => void)[] = [];
  answer<T>(value: T): Promise<T> {
    if (!this.dead) return Promise.resolve(value);
    return new Promise<T>((_, reject) => this.pending.push(reject));
  }
  noop() {
    return this.answer(undefined);
  }
  close() {
    this.closed++;
    this.usable = false;
    for (const reject of this.pending.splice(0)) reject(Object.assign(new Error("Connection not available"), { code: "NoConnection" }));
  }
  logout() {
    this.close();
    return Promise.resolve();
  }
}

const clients: FakeClient[] = [];
vi.mock("@/server/row-mail/connect", async () => {
  class MailConnectError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    MailConnectError,
    connectError: (error: unknown) => (error instanceof MailConnectError ? error : new MailConnectError("unreachable", String((error as Error)?.message))),
    openImap: async () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
  };
});

const { ConnectionLost, withImap, closeImap } = await import("./pool");

const box = (id: string) => ({ id, imapHost: "imap.example.com", imapPort: 993, imapSecure: true, username: "me", auth: "password", secret: "s" }) as never;
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  clients.length = 0;
});
afterEach(() => {
  closeImap("a");
  vi.useRealTimers();
});

describe("withImap", () => {
  it("closes a connection that stops answering, and the next call gets a new one", async () => {
    const first = withImap(box("a"), async (client) => {
      (client as unknown as FakeClient).dead = true;
      return (client as unknown as FakeClient).answer("body");
    }, "open", { within: 20_000 });
    const caught = first.catch((error) => error);
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await caught).toBeInstanceOf(ConnectionLost);
    expect(clients[0].closed).toBeGreaterThan(0);

    const second = withImap(box("a"), async (client) => (client as unknown as FakeClient).answer("body"), "open", { within: 20_000 });
    expect(await second).toBe("body");
    expect(clients).toHaveLength(2);
  });

  it("doesn't hold a click behind a keep-alive the server never answers", async () => {
    expect(await withImap(box("a"), async () => "first")).toBe("first");
    clients[0].dead = true;
    // The keep-alive goes out, and hangs.
    await vi.advanceTimersByTimeAsync(25_000);
    const click = withImap(box("a"), async (client) => (client as unknown as FakeClient).answer("body"), "open", { within: 20_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await click).toBe("body");
    expect(clients).toHaveLength(2);
    expect(clients[0].closed).toBeGreaterThan(0);
  });

  it("lets work without a deadline take its time", async () => {
    let done!: (value: string) => void;
    const slow = withImap(box("a"), () => new Promise<string>((resolve) => (done = resolve)));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    done("file");
    expect(await slow).toBe("file");
    expect(clients[0].closed).toBe(0);
  });
});
