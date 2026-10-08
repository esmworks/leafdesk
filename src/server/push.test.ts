import { describe, expect, it, vi } from "vitest";
import { preferencesFrom, pushWanted } from "./notification-preferences";
import { pushTarget, PushTargetError } from "./push";

vi.mock("@/db", () => ({ db: {} }));

describe("push preferences", () => {
  it("are on for every kind until turned off", () => {
    const preferences = preferencesFrom(undefined);
    expect(preferences.mention).toEqual({ inbox: true, email: true, push: true });
    expect(pushWanted(preferences, "mention")).toBe(true);
  });

  it("follow the inbox: a kind kept out of it isn't pushed, whatever push says", () => {
    const preferences = preferencesFrom({ mentionInbox: false, commentPush: false, assignmentInbox: false, assignmentPush: true });
    expect(pushWanted(preferences, "mention")).toBe(false);
    expect(pushWanted(preferences, "assignment")).toBe(false);
    // Turned off for push only: still in the inbox, not pushed.
    expect(preferences.comment).toEqual({ inbox: true, email: true, push: false });
    expect(pushWanted(preferences, "comment")).toBe(false);
    expect(pushWanted(preferences, "page_shared")).toBe(true);
  });

  it("always push an agent's call waiting for approval", () => {
    const allOff = preferencesFrom(
      Object.fromEntries(
        ["assignment", "share", "comment", "mention", "reminder", "accessRequest", "joinRequest", "automation"].flatMap((k) => [
          [`${k}Inbox`, false],
          [`${k}Push`, false],
        ]),
      ),
    );
    expect(pushWanted(allOff, "agent_approval")).toBe(true);
    expect(pushWanted(allOff, "join_request")).toBe(false);
  });
});

describe("pushTarget", () => {
  it("sends only to public https addresses on the usual port", async () => {
    await expect(pushTarget(new URL("https://8.8.8.8/push/abc"), [])).resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expect(pushTarget(new URL("http://8.8.8.8/push/abc"), [])).rejects.toBeInstanceOf(PushTargetError);
    await expect(pushTarget(new URL("https://8.8.8.8:8443/push"), [])).rejects.toBeInstanceOf(PushTargetError);
    for (const internal of ["https://127.0.0.1/x", "https://10.0.0.5/x", "https://169.254.169.254/latest", "https://[::1]/x", "https://localhost/x", "https://push.internal/x"]) {
      await expect(pushTarget(new URL(internal), []), internal).rejects.toBeInstanceOf(PushTargetError);
    }
  });

  it("lets allowed hosts through, http included, resolved as usual", async () => {
    await expect(pushTarget(new URL("http://127.0.0.1:8080/push"), ["127.0.0.1:8080"])).resolves.toBeNull();
    await expect(pushTarget(new URL("https://push.lan/x"), ["push.lan"])).resolves.toBeNull();
    await expect(pushTarget(new URL("http://127.0.0.1:9090/push"), ["127.0.0.1:8080"])).rejects.toBeInstanceOf(PushTargetError);
  });
});
