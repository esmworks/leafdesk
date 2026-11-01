import { describe, expect, it } from "vitest";
import { mailPushPayload, type NewMail } from "./mail-push";

const t = (key: string, values?: Record<string, string | number>) => (values ? `${key}(${JSON.stringify(values)})` : key);
const box = { id: "b1", workspaceId: "w1", address: "me@example.com" };
const mail = (id: string, fromName: string | null, fromAddress = `${id}@example.com`): NewMail => ({ id, threadId: `m:${id}`, folderId: "inbox", fromName, fromAddress });

describe("mailPushPayload", () => {
  it("sends nothing for no mail", () => {
    expect(mailPushPayload(box, [], t)).toBeNull();
  });

  it("names the sender of one message and opens its thread, never saying what it is about", () => {
    expect(mailPushPayload(box, [mail("a", " Ayşe ")], t)).toEqual({
      title: "Ayşe",
      body: "newMail · me@example.com",
      url: "/w/w1/mail?box=b1&f=inbox&t=m%3Aa",
      tag: "mail:a",
      read: "",
      snooze: "",
    });
    expect(mailPushPayload(box, [mail("a", null)], t)?.title).toBe("a@example.com");
    expect(mailPushPayload(box, [mail("a", null, "")], t)?.title).toBe("someone");
  });

  it("counts several, names two senders once each and opens the inbox", () => {
    const payload = mailPushPayload(box, [mail("a", "Ayşe"), mail("b", "Ayşe"), mail("c", "Mehmet"), mail("d", "Can")], t);
    expect(payload).toMatchObject({
      title: 'newMailCount({"count":4})',
      body: 'people({"name":"Ayşe, Mehmet","others":1}) · me@example.com',
      url: "/w/w1/mail?box=b1&f=inbox",
      tag: "mail:b1",
    });
  });
});
