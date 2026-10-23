import { afterEach, describe, expect, it, vi } from "vitest";
import { CELEBRATE_WITHIN_MS } from "@/lib/automations";
import { CELEBRATE_EVENT } from "@/lib/celebrate-event";
import { registerCollab, type CollabService } from "@/server/collab/bridge";
import { celebrate } from "./celebrate";

const sendTo = vi.fn((_channel: string, _userId: string, _event: string) => 2);
registerCollab({ sendTo, broadcast: vi.fn() } as unknown as CollabService);

afterEach(() => sendTo.mockClear());

describe("the celebrate step", () => {
  const now = Date.parse("2026-10-24T10:00:00Z");

  it("sends the event to the windows of the person whose change started the run, and nobody else", () => {
    const outcome = celebrate("ws-1", { actorId: "user-1", createdAt: new Date(now - 1_000) }, now);
    expect(outcome).toEqual({ status: "done", output: { windows: 2 } });
    expect(sendTo).toHaveBeenCalledExactlyOnceWith("ws:ws-1", "user-1", CELEBRATE_EVENT);
  });

  it("is done when the person has no window open, too", () => {
    sendTo.mockReturnValueOnce(0);
    expect(celebrate("ws-1", { actorId: "user-1", createdAt: new Date(now) }, now)).toEqual({ status: "done", output: { windows: 0 } });
  });

  it("skips a run nobody started: schedules, dates, incoming webhooks, anonymous form answers", () => {
    expect(celebrate("ws-1", { actorId: null, createdAt: new Date(now) }, now)).toEqual({ status: "skipped", code: "noPerson" });
    expect(sendTo).not.toHaveBeenCalled();
  });

  it("skips a step reached long after the change", () => {
    expect(celebrate("ws-1", { actorId: "user-1", createdAt: new Date(now - CELEBRATE_WITHIN_MS) }, now).status).toBe("done");
    expect(celebrate("ws-1", { actorId: "user-1", createdAt: new Date(now - CELEBRATE_WITHIN_MS - 1) }, now)).toEqual({ status: "skipped", code: "tooLate" });
    expect(sendTo).toHaveBeenCalledTimes(1);
  });
});
