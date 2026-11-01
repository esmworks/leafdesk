import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_CHANGE_TIMEOUT_MS, DESKTOP_PING_MS, DESKTOP_READ_TIMEOUT_MS, type ServerMessage } from "@/lib/desktop-bridge";
import { callDesktop, closeEndedDesktopSessions, connectDesktop, desktopOf, pingDesktops } from "./registry";

const facts = { strong: false, ssoProviderId: null, ip: "10.0.0.1" };

function fakeApp(userId: string, sessionId = "s1") {
  const sent: ServerMessage[] = [];
  const closed: number[] = [];
  const link = connectDesktop({ userId, sessionId, facts, transport: { send: (m) => sent.push(m), close: (code) => closed.push(code ?? 0) } });
  return { link, sent, closed, hello: (folders: string[]) => link.receive(JSON.stringify({ type: "hello", version: "1.0.0", folders })) };
}

const lastCall = (sent: ServerMessage[]) => sent.filter((m) => m.type === "call").at(-1) as Extract<ServerMessage, { type: "call" }>;

describe("the desktop registry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    closeEndedDesktopSessions("u1", []);
    closeEndedDesktopSessions("u2", []);
    vi.useRealTimers();
  });

  it("counts an app once it says hello with folders", async () => {
    const app = fakeApp("u1");
    expect(desktopOf("u1")).toBeNull();
    app.hello([]);
    expect(desktopOf("u1")).toBeNull();
    app.hello(["Documents"]);
    expect(desktopOf("u1")).toMatchObject({ folders: ["Documents"], version: "1.0.0", facts, sessionId: "s1" });
    expect(await callDesktop("u2", { op: "list", path: "Documents", agent: "A", workspace: "W" })).toEqual({ ok: false, error: "offline" });
  });

  it("matches answers to calls by id", async () => {
    const app = fakeApp("u1");
    app.hello(["Documents"]);
    const answer = callDesktop("u1", { op: "read", path: "Documents/a.md", agent: "A", workspace: "W" });
    const call = lastCall(app.sent);
    expect(call).toMatchObject({ op: "read", path: "Documents/a.md", agent: "A", workspace: "W" });
    app.link.receive(JSON.stringify({ type: "result", id: "someone-else", ok: false, error: "denied" }));
    app.link.receive(JSON.stringify({ type: "result", id: call.id, ok: true, result: { op: "read", text: "hello", bytes: 5 } }));
    expect(await answer).toEqual({ ok: true, result: { op: "read", text: "hello", bytes: 5 } });
  });

  it("times reads out sooner than changes, which wait for the person", async () => {
    const app = fakeApp("u1");
    app.hello(["Documents"]);
    let read: unknown = null;
    let write: unknown = null;
    void callDesktop("u1", { op: "read", path: "Documents/a.md", agent: "A", workspace: "W" }).then((a) => (read = a));
    void callDesktop("u1", { op: "write", path: "Documents/a.md", content: "x", agent: "A", workspace: "W" }).then((a) => (write = a));
    // The app answers the pings meanwhile, as one waiting for its person does.
    const wait = async (ms: number) => {
      for (let left = ms; left > 0; left -= 10_000) {
        await vi.advanceTimersByTimeAsync(Math.min(10_000, left));
        app.link.receive('{"type":"pong"}');
      }
    };
    await wait(DESKTOP_READ_TIMEOUT_MS + 1);
    expect(read).toEqual({ ok: false, error: "timeout" });
    expect(write).toBeNull();
    await wait(DESKTOP_CHANGE_TIMEOUT_MS - DESKTOP_READ_TIMEOUT_MS);
    expect(write).toEqual({ ok: false, error: "timeout" });
  });

  it("ends the calls waiting on an app that goes, and asks the latest of a person's apps", async () => {
    const first = fakeApp("u1", "s1");
    first.hello(["Documents"]);
    vi.advanceTimersByTime(10);
    const second = fakeApp("u1", "s2");
    second.hello(["Work"]);
    expect(desktopOf("u1")?.folders).toEqual(["Work"]);
    const answer = callDesktop("u1", { op: "list", path: "Work", agent: "A", workspace: "W" });
    expect(lastCall(second.sent)).toBeTruthy();
    second.link.closed();
    expect(await answer).toEqual({ ok: false, error: "offline" });
    expect(desktopOf("u1")?.folders).toEqual(["Documents"]);
  });

  it("closes the apps of sessions that ended, and those that stop answering pings", () => {
    const kept = fakeApp("u1", "live");
    kept.hello(["Documents"]);
    const ended = fakeApp("u1", "gone");
    ended.hello(["Work"]);
    closeEndedDesktopSessions("u1", ["live"]);
    expect(ended.closed).toEqual([4403]);
    expect(kept.closed).toEqual([]);
    expect(desktopOf("u1")?.folders).toEqual(["Documents"]);

    const quiet = fakeApp("u2");
    quiet.hello(["Desk"]);
    pingDesktops(Date.now() + DESKTOP_PING_MS);
    expect(quiet.sent.some((m) => m.type === "ping")).toBe(true);
    kept.link.receive('{"type":"pong"}');
    pingDesktops(Date.now() + 2 * DESKTOP_PING_MS + 1);
    expect(quiet.closed).toEqual([4408]);
    expect(desktopOf("u2")).toBeNull();
  });
});
