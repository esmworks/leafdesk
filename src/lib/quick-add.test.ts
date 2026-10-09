import { describe, expect, it } from "vitest";
import { parseQuickAdd, type QuickAddContext } from "./quick-add";

// Saturday 10 October 2026.
const base: QuickAddContext = { locale: "en", today: "2026-10-10" };
const parse = (text: string, context: Partial<QuickAddContext> = {}) => parseQuickAdd(text, { ...base, ...context });

describe("parseQuickAdd: dates", () => {
  it("leaves a title without dates alone", () => {
    expect(parse("Write the launch plan")).toMatchObject({ title: "Write the launch plan", date: null, matches: [] });
  });

  it("reads today, tomorrow and the day after", () => {
    expect(parse("Call the bank today").date).toBe("2026-10-10");
    expect(parse("Call the bank tomorrow").date).toBe("2026-10-11");
    expect(parse("Call the bank day after tomorrow")).toMatchObject({ title: "Call the bank", date: "2026-10-12" });
  });

  it("takes a weekday as the next one after today, and 'next' as next week's", () => {
    expect(parse("Send the offer friday")).toMatchObject({ title: "Send the offer", date: "2026-10-16" });
    // Today is a Saturday: "saturday" is a week away, not today.
    expect(parse("Groceries saturday").date).toBe("2026-10-17");
    expect(parse("Review next tuesday").date).toBe("2026-10-13");
    expect(parse("Review on Fri.").date).toBe("2026-10-16");
    expect(parse("Review on Fri.").title).toBe("Review");
  });

  it("reads next week, next month and counted days, weeks and months", () => {
    expect(parse("Plan next week").date).toBe("2026-10-12");
    expect(parse("Plan next month").date).toBe("2026-11-01");
    expect(parse("Renew in 3 days").date).toBe("2026-10-13");
    expect(parse("Renew in 2 weeks").date).toBe("2026-10-24");
    expect(parse("Renew in 1 month").date).toBe("2026-11-10");
  });

  it("reads written dates, rolling a past one into next year", () => {
    expect(parse("Taxes 2026-12-01").date).toBe("2026-12-01");
    expect(parse("Taxes Oct 15").date).toBe("2026-10-15");
    expect(parse("Taxes October 15th, 2027").date).toBe("2027-10-15");
    expect(parse("Taxes 3 March").date).toBe("2027-03-03");
    expect(parse("Taxes 10/15").date).toBe("2026-10-15");
    expect(parse("Taxes 2/30").date).toBeNull();
  });

  it("does not take a version number or a lone number for a date", () => {
    expect(parse("Release 3.5").date).toBeNull();
    expect(parse("Release 3.5", { locale: "de" }).date).toBeNull();
    expect(parse("Order 12 chairs").date).toBeNull();
  });

  it("uses only the first date", () => {
    const result = parse("Move tomorrow's meeting to friday tomorrow");
    expect(result.date).toBe("2026-10-16");
    expect(result.title).toBe("Move tomorrow's meeting to tomorrow");
  });
});

describe("parseQuickAdd: other languages", () => {
  it("reads Turkish", () => {
    const tr = (text: string) => parse(text, { locale: "tr" });
    // Times are not kept (a date property holds a day), so they stay in the title.
    expect(tr("Teklifi gönder yarın saat 17")).toMatchObject({ title: "Teklifi gönder saat 17", date: "2026-10-11" });
    expect(tr("Rapor cuma").date).toBe("2026-10-16");
    expect(tr("Rapor haftaya cuma")).toMatchObject({ title: "Rapor", date: "2026-10-16" });
    expect(tr("Rapor gelecek hafta").date).toBe("2026-10-12");
    expect(tr("Rapor 3 gün sonra")).toMatchObject({ title: "Rapor", date: "2026-10-13" });
    expect(tr("Vergi 15 Ekim").date).toBe("2026-10-15");
    expect(tr("Vergi 15.11.2026").date).toBe("2026-11-15");
    expect(tr("Vergi 15/11").date).toBe("2026-11-15");
    expect(tr("Bugün toplantı").date).toBe("2026-10-10");
    // English words still work.
    expect(tr("Rapor tomorrow").date).toBe("2026-10-11");
  });

  it("reads German", () => {
    const de = (text: string) => parse(text, { locale: "de" });
    expect(de("Angebot am Freitag")).toMatchObject({ title: "Angebot", date: "2026-10-16" });
    expect(de("Angebot übermorgen").date).toBe("2026-10-12");
    expect(de("Angebot nächsten Dienstag").date).toBe("2026-10-13");
    expect(de("Angebot in 2 Wochen").date).toBe("2026-10-24");
    expect(de("Steuer 15. Oktober").date).toBe("2026-10-15");
    expect(de("Steuer 15.10.").date).toBe("2026-10-15");
  });

  it("reads Spanish and French", () => {
    expect(parse("Oferta el próximo viernes", { locale: "es" })).toMatchObject({
      title: "Oferta",
      date: "2026-10-16",
    });
    expect(parse("Oferta pasado mañana", { locale: "es" }).date).toBe("2026-10-12");
    expect(parse("Impuestos 15 de octubre", { locale: "es" }).date).toBe("2026-10-15");
    expect(parse("Offre vendredi prochain", { locale: "fr" })).toMatchObject({
      title: "Offre",
      date: "2026-10-16",
    });
    expect(parse("Offre aujourd’hui", { locale: "fr" }).date).toBe("2026-10-10");
    expect(parse("Offre dans 3 jours", { locale: "fr" }).date).toBe("2026-10-13");
  });
});

describe("parseQuickAdd: people and options", () => {
  const people = [
    { id: "u1", name: "Ayşe Yılmaz" },
    { id: "u2", name: "Ayşe Kaya" },
    { id: "u3", name: "Bob" },
  ];
  const options = [
    { propertyId: "p", optionId: "o1", name: "High" },
    { propertyId: "s", optionId: "o2", name: "In progress" },
  ];

  it("takes @ people by full or first name, the longest match winning", () => {
    expect(parse("Review @Ayşe Kaya", { people })).toMatchObject({ title: "Review", people: ["u2"] });
    expect(parse("Review @ayse", { people }).people).toEqual(["u1"]);
    expect(parse("Review @bob and @Ayşe Yılmaz", { people })).toMatchObject({ title: "Review and", people: ["u3", "u1"] });
    expect(parse("Mail @bobby", { people })).toMatchObject({ title: "Mail @bobby", people: [] });
  });

  it("takes # options, with dashes for spaces", () => {
    expect(parse("Fix login #high #in-progress", { options })).toMatchObject({
      title: "Fix login",
      options: [options[0], options[1]],
    });
    expect(parse("Fix #3 bug", { options })).toMatchObject({ title: "Fix #3 bug", options: [] });
  });

  it("records where each part was found", () => {
    const text = "Call @Bob tomorrow, #high";
    const { matches } = parse(text, { people, options });
    expect(matches.map((m) => [m.kind, m.text])).toEqual([
      ["person", "@Bob"],
      ["date", "tomorrow"],
      ["option", "#high"],
    ]);
    for (const m of matches) expect(text.slice(m.start, m.end)).toBe(m.text);
  });

  it("keeps the parts the person chose to keep", () => {
    const result = parse("Read Friday by Kafka tomorrow", { ignored: new Set(["Friday"]) });
    expect(result).toMatchObject({ title: "Read Friday by Kafka", date: "2026-10-11" });
  });

  it("leaves dates in the title when there is nowhere to put them", () => {
    expect(parse("Call the bank tomorrow", { dates: false })).toMatchObject({ title: "Call the bank tomorrow", date: null, matches: [] });
  });
});
