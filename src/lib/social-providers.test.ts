import { describe, expect, it } from "vitest";
import { socialProvidersFrom } from "./social-providers";

describe("socialProvidersFrom", () => {
  it("turns nothing on without variables", () => {
    expect(socialProvidersFrom({})).toEqual({});
  });

  it("turns on each provider that has both an id and a secret", () => {
    expect(
      socialProvidersFrom({
        GITHUB_CLIENT_ID: "gh-id",
        GITHUB_CLIENT_SECRET: "gh-secret",
        GOOGLE_CLIENT_ID: " g-id ",
        GOOGLE_CLIENT_SECRET: "g-secret\n",
      }),
    ).toEqual({
      github: { clientId: "gh-id", clientSecret: "gh-secret" },
      google: { clientId: "g-id", clientSecret: "g-secret" },
    });
  });

  it("takes Apple's secret as it is given", () => {
    expect(socialProvidersFrom({ APPLE_CLIENT_ID: "com.example.web", APPLE_CLIENT_SECRET: "eyJ.jwt.sig" })).toEqual({
      apple: { clientId: "com.example.web", clientSecret: "eyJ.jwt.sig" },
    });
  });

  it("leaves a provider off when half configured or blank", () => {
    expect(socialProvidersFrom({ GITHUB_CLIENT_ID: "gh-id", GOOGLE_CLIENT_SECRET: "g-secret" })).toEqual({});
    expect(socialProvidersFrom({ GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "  " })).toEqual({});
    expect(Object.keys(socialProvidersFrom({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" }))).toEqual(["google"]);
  });
});
