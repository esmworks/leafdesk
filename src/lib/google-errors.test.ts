import { describe, expect, it } from "vitest";
import { googleTriesLater } from "./google-errors";

describe("googleTriesLater", () => {
  it("passes on limits and outages", () => {
    expect(googleTriesLater("Quota exceeded for quota metric 'Read requests' and limit 'Read requests per minute per user'")).toBe(true);
    expect(googleTriesLater("Error 403: User Rate Limit Exceeded (rateLimitExceeded)")).toBe(true);
    expect(googleTriesLater("Request failed with status code 503")).toBe(true);
    expect(googleTriesLater("The service is currently unavailable.")).toBe(true);
    expect(googleTriesLater("Internal error encountered.")).toBe(true);
    expect(googleTriesLater("RESOURCE_EXHAUSTED")).toBe(true);
    expect(googleTriesLater("backendError")).toBe(true);
    expect(googleTriesLater("The request timed out")).toBe(true);
  });

  it("leaves what won't pass", () => {
    expect(googleTriesLater("The caller does not have permission")).toBe(false);
    expect(googleTriesLater("Requested entity was not found.")).toBe(false);
    expect(googleTriesLater("Unable to parse range: Sheet1!A1:Z")).toBe(false);
  });
});
