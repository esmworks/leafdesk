import { describe, expect, it } from "vitest";
import { negotiateLocale } from "./config";

describe("negotiateLocale", () => {
  it("takes the first language the browser asks for that Leafdesk speaks", () => {
    expect(negotiateLocale("fi-FI,fi;q=0.9,en;q=0.8")).toBe("fi");
    expect(negotiateLocale("is,sv;q=0.8,en;q=0.5")).toBe("sv");
    expect(negotiateLocale("pt-BR")).toBe("pt");
    expect(negotiateLocale("en;q=0.5,da;q=0.9")).toBe("da");
    expect(negotiateLocale("is")).toBe("en");
    expect(negotiateLocale(null)).toBe("en");
  });

  it("reads Norwegian, and Nynorsk, as Bokmål", () => {
    expect(negotiateLocale("no")).toBe("nb");
    expect(negotiateLocale("nn-NO,en;q=0.5")).toBe("nb");
    expect(negotiateLocale("nb-NO")).toBe("nb");
  });
});
