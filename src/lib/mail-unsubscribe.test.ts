import { describe, expect, it } from "vitest";
import { unsubscribeOffer, unsubscribeTargets } from "./mail-unsubscribe";

describe("unsubscribeTargets", () => {
  it("reads the web address, the address to mail and the one-click promise", () => {
    expect(unsubscribeTargets("<mailto:Leave@List.test?subject=Stop%20it&body=please>, <https://list.test/u?id=1>", "List-Unsubscribe=One-Click")).toEqual({
      https: "https://list.test/u?id=1",
      mail: { address: "leave@list.test", subject: "Stop it", body: "please" },
      oneClick: true,
    });
  });

  it("takes no one-click without an https address, nor plain http", () => {
    expect(unsubscribeTargets("<mailto:a@list.test>", "List-Unsubscribe=One-Click").oneClick).toBe(false);
    expect(unsubscribeTargets("<http://list.test/u>", "List-Unsubscribe=One-Click")).toEqual({ https: null, mail: null, oneClick: false });
    expect(unsubscribeTargets("<https://list.test/u>", "something else").oneClick).toBe(false);
  });

  it("joins an address folded over lines and leaves out what isn't an address", () => {
    expect(unsubscribeTargets("<https://list.test/\n u?id=2>", undefined).https).toBe("https://list.test/u?id=2");
    expect(unsubscribeTargets("<mailto:a@list.test,b@list.test>", undefined).mail).toBeNull();
    expect(unsubscribeTargets("<mailto:%E0%A4%A>", undefined).mail).toBeNull();
    expect(unsubscribeTargets(undefined, undefined)).toEqual({ https: null, mail: null, oneClick: false });
  });

  it("keeps a subject to one line", () => {
    expect(unsubscribeTargets("<mailto:a@list.test?subject=one%0D%0ABcc:%20x@y.test>", undefined).mail?.subject).toBe("one Bcc: x@y.test");
  });
});

describe("unsubscribeOffer", () => {
  const all = unsubscribeTargets("<mailto:a@list.test>, <https://list.test/u>", "List-Unsubscribe=One-Click");
  const mailOnly = unsubscribeTargets("<mailto:a@list.test>, <https://list.test/u>", undefined);

  it("prefers one click, then a mail, then the web page", () => {
    expect(unsubscribeOffer(all, false)).toEqual({ how: "oneClick" });
    expect(unsubscribeOffer(mailOnly, false)).toEqual({ how: "mail", address: "a@list.test" });
    expect(unsubscribeOffer(unsubscribeTargets("<https://list.test/u>", undefined), false)).toEqual({ how: "web", url: "https://list.test/u" });
  });

  it("offers a sender that failed the provider's check only its web page", () => {
    expect(unsubscribeOffer(all, true)).toEqual({ how: "web", url: "https://list.test/u" });
    expect(unsubscribeOffer(unsubscribeTargets("<mailto:a@list.test>", undefined), true)).toBeNull();
  });
});
