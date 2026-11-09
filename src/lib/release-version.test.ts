import { describe, expect, it } from "vitest";
import { compareVersions, isNewerVersion, parseVersion, versionLabel } from "./release-version";

describe("release versions", () => {
  it("reads tags with or without a v", () => {
    expect(parseVersion("v0.8.0")).toEqual({ core: [0, 8, 0], pre: [] });
    expect(parseVersion("0.8.0")).toEqual({ core: [0, 8, 0], pre: [] });
    expect(parseVersion("1.2.3-beta.1")).toEqual({ core: [1, 2, 3], pre: ["beta", 1] });
    expect(versionLabel("v0.9.0")).toBe("0.9.0");
  });

  it("refuses what isn't a version", () => {
    for (const value of ["", "latest", "v1", "1.2", "1.2.x", "1.2.3.4", "1.2.3-", "1.2.3-a..b", "vv1.2.3"]) {
      expect(parseVersion(value)).toBeNull();
      expect(isNewerVersion(value, "0.8.0")).toBe(false);
    }
  });

  it("compares numbers, not text", () => {
    expect(isNewerVersion("v0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);
    expect(isNewerVersion("0.8.1", "0.8.0")).toBe(true);
  });

  it("is not newer when equal", () => {
    expect(compareVersions("v0.8.0", "0.8.0")).toBe(0);
    expect(isNewerVersion("v0.8.0", "0.8.0")).toBe(false);
  });

  it("puts prereleases before their release", () => {
    expect(isNewerVersion("0.9.0-beta.1", "0.9.0")).toBe(false);
    expect(isNewerVersion("0.9.0", "0.9.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.9.0-beta.1", "0.8.0")).toBe(true);
    expect(isNewerVersion("0.9.0-beta.2", "0.9.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.9.0-beta.10", "0.9.0-beta.9")).toBe(true);
    expect(isNewerVersion("0.9.0-rc.1", "0.9.0-beta.5")).toBe(true);
    expect(isNewerVersion("0.9.0-beta", "0.9.0-beta.1")).toBe(false);
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
  });

  it("ignores build metadata", () => {
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
  });
});
