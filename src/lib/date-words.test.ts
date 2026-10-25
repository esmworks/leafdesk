import { describe, expect, it } from "vitest";
import { readDay } from "./date-words";
import { dayNumber, dayString } from "./time-zone";

describe("readDay", () => {
  // Saturday 10 October 2026.
  const read = (text: string, locale = "en") => {
    const day = readDay(text, locale, dayNumber("2026-10-10"));
    return day === null ? null : dayString(day);
  };

  it("reads a date written on its own, future and past", () => {
    expect(read("friday")).toBe("2026-10-16");
    expect(read("next friday")).toBe("2026-10-16");
    expect(read("Next Friday")).toBe("2026-10-16");
    expect(read("in 3 days")).toBe("2026-10-13");
    expect(read("3 days ago")).toBe("2026-10-07");
    expect(read("2 weeks ago")).toBe("2026-09-26");
    expect(read("1 month ago")).toBe("2026-09-10");
    expect(read("yesterday")).toBe("2026-10-09");
    expect(read("tomorrow")).toBe("2026-10-11");
    expect(read("2026-12-01")).toBe("2026-12-01");
  });

  it("refuses text that is more than a date", () => {
    expect(read("friday meeting")).toBeNull();
    expect(read("call mom")).toBeNull();
    expect(read("")).toBeNull();
    // "3 days" alone says neither when nor which way.
    expect(read("3 days")).toBeNull();
  });

  it("reads Germanic languages", () => {
    expect(read("nächsten Freitag", "de")).toBe("2026-10-16");
    expect(read("vor 3 Tagen", "de")).toBe("2026-10-07");
    expect(read("gestern", "de")).toBe("2026-10-09");
    expect(read("for 3 dage siden", "da")).toBe("2026-10-07");
    expect(read("for 2 uker siden", "nb")).toBe("2026-09-26");
    expect(read("för 3 dagar sedan", "sv")).toBe("2026-10-07");
    expect(read("3 dagen geleden", "nl")).toBe("2026-10-07");
    // Danish "for" alone is not a date.
    expect(read("for 3 dage", "da")).toBeNull();
  });

  it("reads Romance languages", () => {
    expect(read("hace 3 días", "es")).toBe("2026-10-07");
    expect(read("il y a 3 jours", "fr")).toBe("2026-10-07");
    expect(read("3 giorni fa", "it")).toBe("2026-10-07");
    expect(read("há 3 dias", "pt")).toBe("2026-10-07");
    expect(read("ontem", "pt")).toBe("2026-10-09");
  });

  it("reads Slavic, Turkic, Finnic, Semitic and Iranian languages", () => {
    expect(read("3 dni temu", "pl")).toBe("2026-10-07");
    expect(read("3 дня назад", "ru")).toBe("2026-10-07");
    expect(read("3 gün önce", "tr")).toBe("2026-10-07");
    expect(read("gelecek cuma", "tr")).toBe("2026-10-16");
    expect(read("dün", "tr")).toBe("2026-10-09");
    expect(read("3 päivää sitten", "fi")).toBe("2026-10-07");
    expect(read("قبل 3 أيام", "ar")).toBe("2026-10-07");
    expect(read("לפני 3 ימים", "he")).toBe("2026-10-07");
    expect(read("3 روز پیش", "fa")).toBe("2026-10-07");
  });

  it("reads East and Southeast Asian languages", () => {
    expect(read("3日前", "ja")).toBe("2026-10-07");
    expect(read("昨日", "ja")).toBe("2026-10-09");
    expect(read("3天前", "zh")).toBe("2026-10-07");
    expect(read("3일 전", "ko")).toBe("2026-10-07");
    expect(read("3 hari lalu", "id")).toBe("2026-10-07");
    expect(read("3 ngày trước", "vi")).toBe("2026-10-07");
  });

  it("falls back to English in another language", () => {
    expect(read("next friday", "de")).toBe("2026-10-16");
  });
});
