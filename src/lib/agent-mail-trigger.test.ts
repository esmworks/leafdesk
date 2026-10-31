import { describe, expect, it } from "vitest";
import { mailTriggerTakes, NO_MAIL_FILTERS, parseMailSenders, parseMailTrigger, senderAllowed, subjectAllowed } from "./agent-mail-trigger";
import { MAX_MAIL_SENDERS, MAX_MAIL_TASK } from "./agents";

describe("an agent's trigger on new email", () => {
  it("reads senders as addresses or domains, and nothing else", () => {
    expect(parseMailSenders("Ayse@Example.com, @acme.test; partner.co.uk")).toEqual(["ayse@example.com", "@acme.test", "@partner.co.uk"]);
    expect(parseMailSenders(["@acme.test", "acme.test"])).toEqual(["@acme.test"]);
    expect(parseMailSenders("")).toEqual([]);
    expect(parseMailSenders("not a domain")).toBeNull();
    expect(parseMailSenders("@")).toBeNull();
    expect(parseMailSenders([1])).toBeNull();
    expect(parseMailSenders(Array.from({ length: MAX_MAIL_SENDERS + 1 }, (_, i) => `a${i}@x.test`))).toBeNull();
  });

  it("takes a sender by address or by domain, its subdomains too", () => {
    expect(senderAllowed("ayse@acme.test", [])).toBe(true);
    expect(senderAllowed("Ayse@Acme.test", ["ayse@acme.test"])).toBe(true);
    expect(senderAllowed("ali@acme.test", ["ayse@acme.test"])).toBe(false);
    expect(senderAllowed("ali@eu.acme.test", ["@acme.test"])).toBe(true);
    expect(senderAllowed("ali@notacme.test", ["@acme.test"])).toBe(false);
  });

  it("takes a subject with every word of the filter, ignoring case", () => {
    expect(subjectAllowed("Re: Teklif talebi", "")).toBe(true);
    expect(subjectAllowed("Re: TEKLIF talebi", "teklif talebi")).toBe(true);
    expect(subjectAllowed("Re: teklif", "teklif talebi")).toBe(false);
  });

  it("never takes the owner's own mail, drafts or mail a machine wrote", () => {
    const message = { fromAddress: "ayse@acme.test", subject: "Teklif", draft: false, automated: false };
    expect(mailTriggerTakes(message, ["me@x.test"], NO_MAIL_FILTERS)).toBe(true);
    expect(mailTriggerTakes({ ...message, fromAddress: "ME@x.test" }, ["me@x.test"], NO_MAIL_FILTERS)).toBe(false);
    expect(mailTriggerTakes({ ...message, draft: true }, [], NO_MAIL_FILTERS)).toBe(false);
    expect(mailTriggerTakes({ ...message, automated: true }, [], NO_MAIL_FILTERS)).toBe(false);
    expect(mailTriggerTakes({ ...message, fromAddress: "" }, [], NO_MAIL_FILTERS)).toBe(false);
    expect(mailTriggerTakes(message, [], { ...NO_MAIL_FILTERS, senders: ["@other.test"] })).toBe(false);
    expect(mailTriggerTakes(message, [], { ...NO_MAIL_FILTERS, subject: "fatura" })).toBe(false);
  });

  it("needs a task to be turned on, and checks every part", () => {
    expect(parseMailTrigger({ on: true, task: "  Summarize it ", filters: { senders: "@acme.test", subject: " teklif   talebi " } })).toEqual({
      on: true,
      task: "Summarize it",
      filters: { senders: ["@acme.test"], subject: "teklif talebi", knownOnly: false },
    });
    expect(parseMailTrigger({ on: false, task: "" })).toEqual({ on: false, task: "", filters: NO_MAIL_FILTERS });
    expect(parseMailTrigger({ on: true, task: " " })).toBeNull();
    expect(parseMailTrigger({ on: true, task: "x".repeat(MAX_MAIL_TASK + 1) })).toBeNull();
    expect(parseMailTrigger({ on: true, task: "x", filters: { senders: "nope" } })).toBeNull();
    expect(parseMailTrigger({ on: true, task: "x", filters: { knownOnly: "yes" } })).toBeNull();
    expect(parseMailTrigger({ on: "yes", task: "x" })).toBeNull();
    expect(parseMailTrigger(null)).toBeNull();
  });
});
