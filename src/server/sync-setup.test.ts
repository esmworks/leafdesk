import { describe, expect, it } from "vitest";
import { SYNC_SETUPS_PER_HOUR, SYNC_SETUPS_PER_MINUTE, SyncSetupLimited, takeSyncSetup } from "./sync-setup";

describe("takeSyncSetup", () => {
  it("lets a person set up a few syncs a minute and a few dozen an hour", () => {
    const start = Date.UTC(2026, 9, 26, 12);
    for (let i = 0; i < SYNC_SETUPS_PER_MINUTE; i++) takeSyncSetup("u1", start);
    expect(() => takeSyncSetup("u1", start)).toThrow(SyncSetupLimited);
    // Someone else has their own budget.
    expect(() => takeSyncSetup("u2", start)).not.toThrow();

    let at = start + 61_000;
    let taken = SYNC_SETUPS_PER_MINUTE;
    while (taken < SYNC_SETUPS_PER_HOUR) {
      for (let i = 0; i < SYNC_SETUPS_PER_MINUTE && taken < SYNC_SETUPS_PER_HOUR; i++, taken++) takeSyncSetup("u1", at);
      at += 61_000;
    }
    expect(() => takeSyncSetup("u1", at)).toThrow(SyncSetupLimited);
    expect(() => takeSyncSetup("u1", start + 60 * 60_000 + 1)).not.toThrow();
  });
});
