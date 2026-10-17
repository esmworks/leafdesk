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

  it("reads Italian and Portuguese", () => {
    const it_ = (text: string) => parse(text, { locale: "it" });
    expect(it_("Offerta venerdì prossimo")).toMatchObject({ title: "Offerta", date: "2026-10-16" });
    expect(it_("Offerta tra 3 giorni").date).toBe("2026-10-13");
    expect(it_("Tasse 15 ottobre").date).toBe("2026-10-15");
    const pt = (text: string) => parse(text, { locale: "pt" });
    expect(pt("Proposta sexta-feira que vem")).toMatchObject({ title: "Proposta", date: "2026-10-16" });
    expect(pt("Proposta sexta feira").date).toBe("2026-10-16");
    expect(pt("Proposta daqui a 2 semanas").date).toBe("2026-10-24");
    expect(pt("Impostos 15 de outubro").date).toBe("2026-10-15");
    // "segunda" alone is "second", not Monday.
    expect(pt("Revisar a segunda versão").date).toBeNull();
  });

  it("reads Slavic languages, with weekdays and units as they are declined", () => {
    const ru = (text: string) => parse(text, { locale: "ru" });
    expect(ru("Отчёт в пятницу")).toMatchObject({ title: "Отчёт", date: "2026-10-16" });
    expect(ru("Отчёт до пятницы").date).toBe("2026-10-16");
    expect(ru("Отчёт в следующую среду").date).toBe("2026-10-14");
    expect(ru("Отчёт через 1 день").date).toBe("2026-10-11");
    expect(ru("Отчёт через 3 дня").date).toBe("2026-10-13");
    expect(ru("Отчёт через 5 дней").date).toBe("2026-10-15");
    expect(ru("Отчёт на следующей неделе").date).toBe("2026-10-12");
    expect(ru("Налоги 15 октября")).toMatchObject({ title: "Налоги", date: "2026-10-15" });
    expect(parse("Звіт у п’ятницю", { locale: "uk" }).date).toBe("2026-10-16");
    expect(parse("Звіт через 2 тижні", { locale: "uk" }).date).toBe("2026-10-24");
    const pl = (text: string) => parse(text, { locale: "pl" });
    expect(pl("Raport za 3 dni")).toMatchObject({ title: "Raport", date: "2026-10-13" });
    expect(pl("Raport w sobotę").date).toBe("2026-10-17");
    expect(pl("Raport do piątku").date).toBe("2026-10-16");
    expect(pl("Raport w poniedzialek").date).toBe("2026-10-12");
    expect(pl("Podatki 15 października").date).toBe("2026-10-15");
  });

  it("reads Arabic, Hebrew and Persian, with their digits and spellings", () => {
    const ar = (text: string) => parse(text, { locale: "ar" });
    expect(ar("تقرير يوم الجمعة")).toMatchObject({ title: "تقرير", date: "2026-10-16" });
    expect(ar("تقرير الإثنين القادم").date).toBe("2026-10-12");
    expect(ar("تقرير غداً").date).toBe("2026-10-11");
    expect(ar("تقرير بعد ٣ أيام").date).toBe("2026-10-13");
    expect(ar("تقرير الاسبوع القادم").date).toBe("2026-10-12");
    const he = (text: string) => parse(text, { locale: "he" });
    expect(he("דוח יום שני")).toMatchObject({ title: "דוח", date: "2026-10-12" });
    expect(he("דוח ביום שישי הבא").date).toBe("2026-10-16");
    expect(he("דוח בעוד 3 ימים").date).toBe("2026-10-13");
    const fa = (text: string) => parse(text, { locale: "fa" });
    expect(fa("گزارش ۳ روز دیگر")).toMatchObject({ title: "گزارش", date: "2026-10-13" });
    expect(fa("گزارش سه\u200cشنبه").date).toBe("2026-10-13");
    expect(fa("گزارش سه شنبه").date).toBe("2026-10-13");
    expect(fa("گزارش پس فردا").date).toBe("2026-10-12");
    expect(fa("گزارش هفته\u200cی بعد").date).toBe("2026-10-12");
    // Gregorian months, not the Persian calendar's.
    expect(fa("مالیات ۱۵ اکتبر").date).toBe("2026-10-15");
  });

  it("reads Korean, its particles and numbers with units", () => {
    const ko = (text: string) => parse(text, { locale: "ko", people: [{ id: "k", name: "김철수" }] });
    expect(ko("보고서 내일").date).toBe("2026-10-11");
    expect(ko("보고서 다음 주 금요일")).toMatchObject({ title: "보고서", date: "2026-10-16" });
    expect(ko("보고서 금요일까지")).toMatchObject({ title: "보고서", date: "2026-10-16" });
    expect(ko("보고서 3일 후").date).toBe("2026-10-13");
    expect(ko("보고서 2주 뒤에").date).toBe("2026-10-24");
    expect(ko("세금 10월 15일").date).toBe("2026-10-15");
    expect(ko("세금 10/15").date).toBe("2026-10-15");
    expect(ko("검토 @김철수 내일")).toMatchObject({ title: "검토", people: ["k"], date: "2026-10-11" });
  });

  it("reads Japanese, which leaves no spaces between words, a character at a time", () => {
    const ja = (text: string) => parse(text, { locale: "ja", people: [{ id: "t", name: "田中" }] });
    expect(ja("明日会議")).toMatchObject({ title: "会議", date: "2026-10-11" });
    expect(ja("報告書を明後日に送る")).toMatchObject({ title: "報告書を送る", date: "2026-10-12" });
    expect(ja("報告書を金曜日までに送る")).toMatchObject({ title: "報告書を送る", date: "2026-10-16" });
    expect(ja("来週の金曜日に打ち合わせ")).toMatchObject({ title: "打ち合わせ", date: "2026-10-16" });
    expect(ja("来週打ち合わせ").date).toBe("2026-10-12");
    expect(ja("見積もり3日後").date).toBe("2026-10-13");
    expect(ja("見積もり1週間後").date).toBe("2026-10-17");
    expect(ja("税金10月15日")).toMatchObject({ title: "税金", date: "2026-10-15" });
    expect(ja("会議 10/15").date).toBe("2026-10-15");
    expect(ja("会議 tomorrow").date).toBe("2026-10-11");
    expect(ja("確認 @田中 明日")).toMatchObject({ title: "確認", people: ["t"], date: "2026-10-11" });
  });

  it("reads Chinese a character at a time too", () => {
    const zh = (text: string) => parse(text, { locale: "zh" });
    expect(zh("明天开会")).toMatchObject({ title: "开会", date: "2026-10-11" });
    expect(zh("后天交报告").date).toBe("2026-10-12");
    expect(zh("下周五开会")).toMatchObject({ title: "开会", date: "2026-10-16" });
    expect(zh("下个星期五开会").date).toBe("2026-10-16");
    expect(zh("下周开会")).toMatchObject({ title: "开会", date: "2026-10-12" });
    expect(zh("周五前交报告")).toMatchObject({ title: "交报告", date: "2026-10-16" });
    expect(zh("这周五开会").date).toBe("2026-10-16");
    expect(zh("3天后交报告").date).toBe("2026-10-13");
    expect(zh("会议 10月15日")).toMatchObject({ title: "会议", date: "2026-10-15" });
    // Characters that only look like a date part stay in the title.
    expect(zh("天气预报")).toMatchObject({ title: "天气预报", date: null });
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
