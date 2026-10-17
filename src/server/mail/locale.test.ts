import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The language of emails: the recipient's stored language first, then the one the email was queued
 * with (the actor's), then the default. The database answers the stored language from `stored`
 * and records what `rememberLocale` writes.
 */
const state = vi.hoisted(() => ({
  stored: [] as { locale: string | null }[],
  failRead: false,
  reads: 0,
  writes: [] as { values: unknown; set: unknown; where: unknown }[],
}));

/** The literal text of a drizzle `sql` template, enough to tell its conditions apart. */
const sqlText = (value: unknown) =>
  ((value as { queryChunks?: unknown[] })?.queryChunks ?? [])
    .map((chunk) => (chunk as { value?: unknown })?.value)
    .flat()
    .filter((part) => typeof part === "string")
    .join("");

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          state.reads++;
          if (state.failRead) throw new Error("database down");
          return state.stored;
        },
      }),
    }),
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: async ({ set, setWhere }: { set: unknown; setWhere: unknown }) =>
          void state.writes.push({ values, set, where: sqlText(setWhere) }),
      }),
    }),
  },
}));
// Outside a request next-intl has no locale; requestLocale falls back to the default.
vi.mock("next-intl/server", () => ({ getLocale: async () => Promise.reject(new Error("no request")) }));

const { pickLocale, recipientLocale, rememberLocale, requestLocale, statedLanguage, statedLocale } = await import("./locale");

beforeEach(() => {
  state.stored = [];
  state.failRead = false;
  state.reads = 0;
  state.writes = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("pickLocale", () => {
  it("takes the first supported language", () => {
    expect(pickLocale("tr", "en")).toBe("tr");
    expect(pickLocale(null, "de")).toBe("de");
    expect(pickLocale(undefined, "xx", "fr")).toBe("fr");
  });

  it("falls back to English when none is supported", () => {
    expect(pickLocale()).toBe("en");
    expect(pickLocale(null, "pt-br", 3)).toBe("en");
  });
});

describe("recipientLocale", () => {
  it("prefers the recipient's stored language to the actor's", async () => {
    state.stored = [{ locale: "tr" }];
    expect(await recipientLocale("u1", "en")).toBe("tr");
  });

  it("uses the language the email was queued with while the recipient's isn't known", async () => {
    expect(await recipientLocale("u1", "de")).toBe("de");
    state.stored = [{ locale: null }];
    expect(await recipientLocale("u1", "es")).toBe("es");
  });

  it("ignores a stored code that is no longer supported", async () => {
    state.stored = [{ locale: "xx" }];
    expect(await recipientLocale("u1", "fr")).toBe("fr");
  });

  it("doesn't look anything up without a recipient account", async () => {
    expect(await recipientLocale(null, "tr")).toBe("tr");
    expect(state.reads).toBe(0);
  });

  it("falls back instead of failing when the lookup fails", async () => {
    state.failRead = true;
    expect(await recipientLocale("u1", "tr")).toBe("tr");
    expect(await recipientLocale("u1", null)).toBe("en");
  });
});

describe("requestLocale", () => {
  it("is the default outside a request", async () => {
    expect(await requestLocale()).toBe("en");
  });
});

describe("statedLocale", () => {
  it("reads the saved choice first, then Accept-Language", () => {
    expect(statedLocale(new Headers({ cookie: "a=1; NEXT_LOCALE=tr", "accept-language": "de" }))).toBe("tr");
    expect(statedLocale(new Headers({ "accept-language": "fr-CA,fr;q=0.9,en;q=0.5" }))).toBe("fr");
    expect(statedLocale(new Headers({ "accept-language": "nl" }))).toBe("en");
  });

  it("is null for a request that states no language, so nothing is overwritten with the default", () => {
    expect(statedLocale(undefined)).toBeNull();
    expect(statedLocale(new Headers())).toBeNull();
    expect(statedLocale(new Headers({ cookie: "session=abc" }))).toBeNull();
    expect(statedLocale(new Headers({ "accept-language": "*" }))).toBeNull();
  });
});

describe("statedLanguage", () => {
  it("tells a picked language from the browser's", () => {
    expect(statedLanguage(new Headers({ cookie: "NEXT_LOCALE=tr", "accept-language": "de" }))).toEqual({ locale: "tr", chosen: true });
    expect(statedLanguage(new Headers({ "accept-language": "de" }))).toEqual({ locale: "de", chosen: false });
    expect(statedLanguage(new Headers({ "accept-language": "*" }))).toBeNull();
  });
});

describe("rememberLocale", () => {
  it("stores a supported language", async () => {
    await rememberLocale("u1", "tr");
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].values).toEqual({ userId: "u1", locale: "tr" });
    expect(state.writes[0].set).toMatchObject({ locale: "tr" });
  });

  it("replaces any other stored language, or with onlyIfUnknown only an empty one", async () => {
    await rememberLocale("u1", "tr");
    await rememberLocale("u1", "de", { onlyIfUnknown: true });
    const conditions = state.writes.map((w) => JSON.stringify(w.where));
    expect(conditions[0]).toContain("is distinct from");
    expect(conditions[1]).toContain("is null");
    expect(conditions[1]).not.toContain("is distinct from");
  });

  it("writes nothing for an unsupported one", async () => {
    await rememberLocale("u1", "xx");
    await rememberLocale("u1", null);
    expect(state.writes).toHaveLength(0);
  });
});
