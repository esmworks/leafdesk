import { describe, expect, it } from "vitest";
import { formatStyledDateIn } from "./date-format";

describe("formatStyledDateIn", () => {
  it("writes days in each format", () => {
    expect(formatStyledDateIn("2026-10-24", "en", "UTC", { format: "full" })).toBe("October 24, 2026");
    expect(formatStyledDateIn("2026-10-24", "en", "UTC", { format: "short" })).toBe("10/24/2026");
    expect(formatStyledDateIn("2026-10-24", "en", "UTC", { format: "mdy" })).toBe("10/24/2026");
    expect(formatStyledDateIn("2026-10-24", "en", "UTC", { format: "dmy" })).toBe("24/10/2026");
    expect(formatStyledDateIn("2026-10-24", "en", "UTC", { format: "ymd" })).toBe("2026/10/24");
    expect(formatStyledDateIn("2026-10-24", "tr", "UTC", { format: "full" })).toBe("24 Ekim 2026");
  });

  it("keeps days as days whatever the zone", () => {
    expect(formatStyledDateIn("2026-10-24", "en", "America/Los_Angeles", { format: "ymd" })).toBe("2026/10/24");
  });

  it("writes times on the chosen clock, in the zone", () => {
    expect(formatStyledDateIn("2026-10-24T13:05:00.000Z", "en", "Europe/Istanbul", { format: "dmy", clock: "24h" })).toBe("24/10/2026, 16:05");
    expect(formatStyledDateIn("2026-10-24T13:05:00.000Z", "en", "UTC", { clock: "12h" })).toBe("Oct 24, 2026, 1:05 PM");
  });

  it("writes ranges with an arrow, a same-day time range with the end's time only", () => {
    expect(formatStyledDateIn("2026-10-24/2026-10-26", "en", "UTC", { format: "dmy" })).toBe("24/10/2026 → 26/10/2026");
    expect(formatStyledDateIn("2026-10-24T09:00:00.000Z/2026-10-24T10:30:00.000Z", "en", "UTC", { format: "ymd", clock: "24h" })).toBe(
      "2026/10/24, 09:00 → 10:30",
    );
  });

  it("is null for anything else", () => {
    expect(formatStyledDateIn("soon", "en", "UTC", { format: "full" })).toBeNull();
  });
});
