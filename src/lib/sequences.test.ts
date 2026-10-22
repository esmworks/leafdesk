import { describe, expect, it } from "vitest";
import {
  checkWindow,
  DEFAULT_SEND_WINDOW,
  isOutOfOffice,
  nextSendSlot,
  parseReturnDate,
  renderTemplate,
  sequenceVariables,
  spreadMs,
  stepDraftProblems,
  templateProblems,
} from "./sequences";

describe("sequence templates", () => {
  it("reads variables with and without fallbacks", () => {
    expect(sequenceVariables("Hi {{Contact person | there}}, about {{ Company }} and {{x|}}")).toEqual([
      { name: "Contact person", fallback: "there", raw: "{{Contact person | there}}" },
      { name: "Company", fallback: null, raw: "{{ Company }}" },
      { name: "x", fallback: "", raw: "{{x|}}" },
    ]);
  });

  it("refuses a variable without a fallback, without a name, or naming no property", () => {
    const names = ["Contact person", "Company"];
    expect(templateProblems("Hi {{contact person | there}} from {{Sender | us}}", names)).toEqual([]);
    expect(templateProblems("Hi {{Contact person}}", names)).toEqual([{ problem: "noFallback", name: "Contact person" }]);
    expect(templateProblems("Hi {{Company |  }}", names)).toEqual([{ problem: "noFallback", name: "Company" }]);
    expect(templateProblems("Hi {{ | x}}", names)).toEqual([{ problem: "empty", name: "{{ | x}}" }]);
    expect(templateProblems("Hi {{Budget | soon}}", names)).toEqual([{ problem: "unknown", name: "Budget" }]);
  });

  it("writes values in, by name without regard to case, and falls back on empty ones", () => {
    expect(renderTemplate("Hi {{contact PERSON | there}}, {{Company | your team}}!", { "Contact person": "Selin", Company: "  " })).toEqual({
      text: "Hi Selin, your team!",
      fallbacks: ["Company"],
    });
    expect(renderTemplate("{{Missing | friend}}", {}).text).toBe("friend");
    // A value never brings a line break into the subject.
    expect(renderTemplate("Quote for {{Company | you}}", { Company: "Acme\nLtd" }).text).toBe("Quote for Acme Ltd");
  });

  it("checks the step as written, each variable at its fallback", () => {
    expect(stepDraftProblems({ subject: "Your quote, {{Company | you}}", text: "Hello {{Name | there}},\n\nBest,\n{{Sender | us}}" }, true)).toEqual([]);
    expect(stepDraftProblems({ subject: "Quote", text: "Hello **there**" }, true)).toEqual(["markdown"]);
    expect(stepDraftProblems({ subject: "Quote", text: "Hello [Name]" }, true)).toEqual(["placeholder"]);
    expect(stepDraftProblems({ subject: "", text: "" }, false)).toEqual(["emptyText"]);
  });
});

describe("out-of-office replies", () => {
  it("knows them by their headers", () => {
    expect(isOutOfOffice({ autoSubmitted: "auto-replied" })).toBe(true);
    expect(isOutOfOffice({ autoSubmitted: "auto-replied; owner-email=a@b.c" })).toBe(true);
    expect(isOutOfOffice({ xAutoreply: "yes" })).toBe(true);
    expect(isOutOfOffice({ xAutorespond: "Vacation" })).toBe(true);
    expect(isOutOfOffice({ precedence: "auto_reply" })).toBe(true);
    expect(isOutOfOffice({ autoSubmitted: "auto-generated", subject: "Undelivered Mail Returned to Sender" })).toBe(false);
    expect(isOutOfOffice({ autoSubmitted: "no", subject: "Re: Your quote" })).toBe(false);
    expect(isOutOfOffice({ precedence: "bulk", subject: "Newsletter" })).toBe(false);
    expect(isOutOfOffice({ xAutoreply: "no" })).toBe(false);
  });

  it("knows them by their subject in several languages", () => {
    for (const subject of [
      "Out of Office: Re: Your quote",
      "Automatic reply: Your quote",
      "Abwesenheitsnotiz: Ihr Angebot",
      "Réponse automatique : votre devis",
      "Respuesta automática: Su presupuesto",
      "Risposta automatica: preventivo",
      "Otomatik yanıt: Teklifiniz",
      "Автоответ: ваше предложение",
      "Automatische Antwort",
      "自动回复: 报价",
    ]) {
      expect(isOutOfOffice({ subject }), subject).toBe(true);
    }
    expect(isOutOfOffice({ subject: "Re: Office chairs quote" })).toBe(false);
  });

  const now = new Date("2026-10-22T10:00:00Z");
  const back = (text: string) => parseReturnDate(text, now, "Europe/Istanbul");

  it("reads the day they are back in common formats", () => {
    expect(back("I am out of the office until 2026-11-03.")).toBe("2026-11-04");
    expect(back("Ich bin bis 03.11.2026 nicht im Büro.")).toBe("2026-11-04");
    expect(back("Ich bin bis zum 3. November nicht erreichbar.")).toBe("2026-11-04");
    expect(back("I'm away until November 3rd and will reply then.")).toBe("2026-11-04");
    expect(back("Away until 3 Nov.")).toBe("2026-11-04");
    expect(back("Je suis absent jusqu'au 3 novembre 2026.")).toBe("2026-11-04");
    expect(back("Estaré fuera hasta el 3 de noviembre.")).toBe("2026-11-04");
    expect(back("Sarò fuori sede fino al 3 novembre.")).toBe("2026-11-04");
    expect(back("3 Kasım tarihine kadar izindeyim.")).toBe("2026-11-04");
    expect(back("Я в отпуске до 3 ноября.")).toBe("2026-11-04");
    expect(back("Jestem na urlopie do 3 listopada.")).toBe("2026-11-04");
    expect(back("Out until 03/11.")).toBe("2026-11-04");
    // Only the month first makes a date.
    expect(back("Out until 11/23/2026.")).toBe("2026-11-24");
  });

  it("takes a back-on date as it is, and the latest of a range", () => {
    expect(back("I'm out from 25 October to 2 November and back on 3 November.")).toBe("2026-11-03");
    expect(back("Ich bin am 5.11. wieder im Büro.")).toBe("2026-11-05");
    expect(back("Out from 23 October until 30 October.")).toBe("2026-10-31");
  });

  it("finds none in times, ranges, past dates or the message it answers", () => {
    expect(back("I'll answer after 9.30 tomorrow, give me 3-4 days.")).toBeNull();
    expect(back("I was away from 1 October.")).toBeNull();
    expect(back("Thanks for your message.\n\n> The offer is valid until 30 November.")).toBeNull();
    expect(back("Away.\n\nOn Monday, Ada wrote:\nvalid until 30 November")).toBeNull();
    expect(back("Back in 2027-08-01")).toBeNull();
    // A day without a year that has passed is next year's (and too far off here).
    expect(parseReturnDate("Back on 3 January", new Date("2026-12-20T10:00:00Z"), "UTC")).toBe("2027-01-03");
  });
});

describe("send slots", () => {
  const zone = "Europe/Istanbul"; // UTC+3, no daylight saving
  const at = (iso: string) => new Date(iso).getTime();
  const slot = (due: string, over: Partial<Parameters<typeof nextSendSlot>[0]> = {}) => {
    const out = nextSendSlot({ due: at(due), now: at("2026-10-22T07:00:00Z"), window: DEFAULT_SEND_WINDOW, timeZone: zone, sentToday: 0, dailyLimit: 50, ...over });
    return out === null ? null : new Date(out).toISOString();
  };

  it("sends at once inside the window", () => {
    // Thursday 10:00 in Istanbul.
    expect(slot("2026-10-22T07:00:00Z")).toBe("2026-10-22T07:00:00.000Z");
  });

  it("waits for the window to open, and over the weekend", () => {
    // Thursday 07:00 in Istanbul: 09:00 the same day.
    expect(slot("2026-10-22T04:00:00Z", { now: at("2026-10-22T04:00:00Z") })).toBe("2026-10-22T06:00:00.000Z");
    // Friday 18:00: Monday 09:00.
    expect(slot("2026-10-23T15:00:00Z")).toBe("2026-10-26T06:00:00.000Z");
    // Saturday noon: Monday 09:00.
    expect(slot("2026-10-24T09:00:00Z")).toBe("2026-10-26T06:00:00.000Z");
  });

  it("waits for the next day once the daily limit is reached, and for the mailbox's spread", () => {
    expect(slot("2026-10-22T07:00:00Z", { sentToday: 50 })).toBe("2026-10-23T06:00:00.000Z");
    expect(slot("2026-10-22T07:00:00Z", { sentToday: 49 })).toBe("2026-10-22T07:00:00.000Z");
    expect(slot("2026-10-22T07:00:00Z", { notBefore: at("2026-10-22T07:04:00Z") })).toBe("2026-10-22T07:04:00.000Z");
    // A spread past the window's end goes to the next day.
    expect(slot("2026-10-22T13:58:00Z", { now: at("2026-10-22T13:58:00Z"), notBefore: at("2026-10-22T14:03:00Z") })).toBe("2026-10-23T06:00:00.000Z");
  });

  it("follows daylight saving in the sender's zone", () => {
    // Berlin goes from UTC+2 to UTC+1 on 25 October 2026: Monday 09:00 is 08:00 UTC.
    expect(
      new Date(nextSendSlot({ due: at("2026-10-24T10:00:00Z"), now: at("2026-10-24T10:00:00Z"), window: DEFAULT_SEND_WINDOW, timeZone: "Europe/Berlin", sentToday: 0, dailyLimit: 50 })!).toISOString(),
    ).toBe("2026-10-26T08:00:00.000Z");
  });

  it("finds nothing in a window without days", () => {
    expect(nextSendSlot({ due: 0, now: 0, window: { days: [], start: 0, end: 60 }, timeZone: "UTC", sentToday: 0, dailyLimit: 1 })).toBeNull();
  });

  it("spreads sends by a few minutes", () => {
    expect(spreadMs(() => 0)).toBe(120_000);
    expect(spreadMs(() => 1)).toBe(420_000);
  });

  it("checks a window as typed", () => {
    expect(checkWindow({ days: [5, 1], start: 540, end: 1020 })).toEqual({ days: [1, 5], start: 540, end: 1020 });
    expect(checkWindow({ days: [1, 1], start: 540, end: 1020 })).toBeNull();
    expect(checkWindow({ days: [7], start: 540, end: 1020 })).toBeNull();
    expect(checkWindow({ days: [1], start: 600, end: 600 })).toBeNull();
    expect(checkWindow({ days: [1], start: 0, end: 1441 })).toBeNull();
  });
});
