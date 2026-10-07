import { describe, expect, it, vi } from "vitest";
import { agentEmail } from "@/lib/agents";
import { MailConfigError, readMailConfig } from "./config";
import { sendMail } from "./index";
import {
  accessApprovedEmail,
  accessDeclinedEmail,
  accessRequestEmail,
  assignmentEmail,
  automationEmail,
  invitationEmail,
  PASSWORD_RESET_MINUTES,
  passwordResetEmail,
  renderEmail,
  shareEmail,
  testEmail,
} from "./templates";

const FROM = "Leafdesk <no-reply@example.com>";

describe("sendMail", () => {
  it("drops mail to an agent's address, whatever sent it", async () => {
    const printed = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(sendMail({ to: agentEmail("a1"), subject: "Hi", text: "Hi", html: "<p>Hi</p>" })).resolves.toBeUndefined();
      expect(printed).not.toHaveBeenCalled();
    } finally {
      printed.mockRestore();
    }
  });
});

describe("readMailConfig", () => {
  it("is off without SMTP settings", () => {
    expect(readMailConfig({})).toBeNull();
    expect(readMailConfig({ MAIL_FROM: FROM })).toBeNull();
  });

  it("requires MAIL_FROM once SMTP is set", () => {
    expect(() => readMailConfig({ SMTP_HOST: "smtp.example.com" })).toThrow(MailConfigError);
  });

  it("accepts an SMTP URL and keeps credentials out of the description", () => {
    const config = readMailConfig({ SMTP_URL: "smtps://user:secret@smtp.example.com:465", MAIL_FROM: FROM });
    expect(config?.transport.url).toBe("smtps://user:secret@smtp.example.com:465");
    expect(config?.description).toBe("smtps://smtp.example.com:465");
    expect(config?.from).toBe(FROM);
  });

  it("rejects URLs that are not SMTP", () => {
    expect(() => readMailConfig({ SMTP_URL: "https://smtp.example.com", MAIL_FROM: FROM })).toThrow(MailConfigError);
    expect(() => readMailConfig({ SMTP_URL: "not a url", MAIL_FROM: FROM })).toThrow(MailConfigError);
  });

  it("defaults to port 587 with STARTTLS, and 465 for implicit TLS", () => {
    const plain = readMailConfig({ SMTP_HOST: "smtp.example.com", MAIL_FROM: FROM });
    expect(plain?.transport).toMatchObject({ host: "smtp.example.com", port: 587, secure: false, auth: undefined });

    const tls = readMailConfig({ SMTP_HOST: "smtp.example.com", SMTP_SECURE: "true", MAIL_FROM: FROM });
    expect(tls?.transport).toMatchObject({ port: 465, secure: true });

    const byPort = readMailConfig({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", MAIL_FROM: FROM });
    expect(byPort?.transport).toMatchObject({ port: 465, secure: true });
  });

  it("passes credentials and validates values", () => {
    const config = readMailConfig({
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "2525",
      SMTP_USER: "apikey",
      SMTP_PASSWORD: "secret",
      MAIL_FROM: FROM,
    });
    expect(config?.transport).toMatchObject({ port: 2525, secure: false, auth: { user: "apikey", pass: "secret" } });
    expect(config?.description).toBe("smtp.example.com:2525");

    expect(() => readMailConfig({ SMTP_HOST: "h", SMTP_PORT: "70000", MAIL_FROM: FROM })).toThrow(MailConfigError);
    expect(() => readMailConfig({ SMTP_HOST: "h", SMTP_SECURE: "maybe", MAIL_FROM: FROM })).toThrow(MailConfigError);
  });
});

describe("renderEmail", () => {
  it("escapes content in the HTML version and keeps the text version plain", () => {
    const email = renderEmail("en", {
      subject: "Hi",
      heading: "<Welcome>",
      paragraphs: ['Tom & "Jerry"'],
      action: { label: "Open", url: "https://example.com/a?b=1&c=2" },
    });
    expect(email.html).toContain("&lt;Welcome&gt;");
    expect(email.html).toContain("Tom &amp; &quot;Jerry&quot;");
    expect(email.html).toContain('href="https://example.com/a?b=1&amp;c=2"');
    expect(email.html).not.toContain("<Welcome>");
    expect(email.text).toContain("<Welcome>");
    expect(email.text).toContain("Open: https://example.com/a?b=1&c=2");
  });

  it("refuses non-http links", () => {
    expect(() =>
      renderEmail("en", { subject: "x", heading: "x", paragraphs: [], action: { label: "x", url: "javascript:alert(1)" } }),
    ).toThrow();
  });

  it("renders the test email in both languages", () => {
    expect(testEmail("en").subject).toBe("Test email from Leafdesk");
    const tr = testEmail("tr");
    expect(tr.subject).toBe("Leafdesk test e-postası");
    expect(tr.html).toContain('<html lang="tr">');
    expect(tr.text).toContain("E-posta gönderimi çalışıyor");
  });
});

describe("invitationEmail", () => {
  const invitation = {
    inviterName: "Erhan",
    workspaceName: "<Sales & Ops>",
    email: "ayse@example.com",
    role: "member" as const,
    link: "https://notes.example.com/invite/abc123",
  };

  it("puts the link and the invited email in both versions", () => {
    const mail = invitationEmail("en", invitation);
    expect(mail.subject).toBe("Erhan invited you to “<Sales & Ops>” on Leafdesk");
    expect(mail.text).toContain("Accept invitation: https://notes.example.com/invite/abc123");
    expect(mail.text).toContain("ayse@example.com");
    expect(mail.html).toContain('href="https://notes.example.com/invite/abc123"');
    expect(mail.html).toContain("&lt;Sales &amp; Ops&gt;");
    expect(mail.html).not.toContain("<Sales & Ops>");
  });

  it("is written in the requested language", () => {
    const mail = invitationEmail("tr", { ...invitation, role: "owner" });
    expect(mail.text).toContain("sahip olarak davet etti");
    expect(mail.text).toContain("Daveti kabul et: https://notes.example.com/invite/abc123");
  });

  it("renders the password reset email with its link and lifetime", () => {
    const url = "http://localhost:3000/api/auth/reset-password/abc?callbackURL=%2Freset-password";
    const en = passwordResetEmail("en", { name: "Ada", url });
    expect(en.subject).toBe("Reset your Leafdesk password");
    expect(en.text).toContain(`Choose a new password: ${url}`);
    expect(en.text).toContain(`${PASSWORD_RESET_MINUTES} minutes`);
    expect(en.html).toContain("Hi Ada,");

    const tr = passwordResetEmail("tr", { name: "Ayşe", url });
    expect(tr.subject).toBe("Leafdesk şifrenizi sıfırlayın");
    expect(tr.text).toContain(`Yeni şifre belirle: ${url}`);
  });
});

describe("assignmentEmail", () => {
  const assignment = {
    actorName: "Erhan",
    rowTitle: "Teklif <hazırla>",
    databaseTitle: "İşlerim",
    propertyName: "Sorumlu",
    link: "https://notes.example.com/w/ws/p/row1",
  };

  it("names who assigned what, with a link to the row", () => {
    const tr = assignmentEmail("tr", assignment);
    expect(tr.subject).toBe("Erhan sizi “Teklif <hazırla>” işine atadı");
    expect(tr.text).toContain("Erhan, sizi İşlerim içinde “Sorumlu” alanına ekledi.");
    expect(tr.text).toContain("Aç: https://notes.example.com/w/ws/p/row1");
    expect(tr.html).toContain("Teklif &lt;hazırla&gt;");

    const en = assignmentEmail("en", assignment);
    expect(en.subject).toBe("Erhan assigned you to “Teklif <hazırla>”");
    expect(en.text).toContain("Erhan added you to “Sorumlu” in İşlerim.");
  });
});

describe("shareEmail", () => {
  const share = {
    actorName: "Erhan",
    pageTitle: "Yol <haritası>",
    workspaceName: "Ekip",
    level: "edit" as const,
    link: "https://notes.example.com/w/ws/p/page1",
  };

  it("names who shared which page and what the reader can do with it", () => {
    const tr = shareEmail("tr", share);
    expect(tr.subject).toBe("Erhan “Yol <haritası>” sayfasını sizinle paylaştı");
    expect(tr.text).toContain("Ekip içindeki “Yol <haritası>” sayfasını artık düzenleyebilirsiniz.");
    expect(tr.text).toContain("Sayfayı aç: https://notes.example.com/w/ws/p/page1");
    expect(tr.html).toContain("Yol &lt;haritası&gt;");

    const en = shareEmail("en", { ...share, level: "full" });
    expect(en.subject).toBe("Erhan shared “Yol <haritası>” with you");
    expect(en.text).toContain("You can now view, edit and share “Yol <haritası>” in Ekip.");
  });
});

describe("automationEmail", () => {
  const automation = {
    automationName: "Bitenleri bildir",
    actorName: "Erhan",
    pageTitle: "Teklif <hazırla>",
    databaseTitle: "İşlerim",
    workspaceName: "Ekip",
    link: "https://notes.example.com/w/ws/p/row1",
  };

  it("names the automation, the row, its database and who changed it", () => {
    const tr = automationEmail("tr", automation);
    expect(tr.subject).toBe("“Bitenleri bildir” otomasyonu: “Teklif <hazırla>”");
    expect(tr.text).toContain("Erhan, Ekip çalışma alanındaki İşlerim içinde “Teklif <hazırla>” satırını ekledi ya da değiştirdi.");
    expect(tr.text).toContain("Satırı aç: https://notes.example.com/w/ws/p/row1");
    expect(tr.html).toContain("Teklif &lt;hazırla&gt;");

    const en = automationEmail("en", { ...automation, actorName: "" });
    expect(en.subject).toBe("Automation “Bitenleri bildir”: “Teklif <hazırla>”");
    expect(en.text).toContain("Someone added or changed “Teklif <hazırla>” in İşlerim (Ekip).");
  });
});

describe("access request emails", () => {
  const link = "https://notes.example.com/w/ws/p/page1";

  it("tells the people with full access who asked, for which page, and what they wrote", () => {
    const request = {
      requesterName: "Ada",
      requesterEmail: "ada@example.com",
      pageTitle: "Bütçe",
      workspaceName: "Ekip",
      message: "Need it for <the> review",
      link,
    };
    const en = accessRequestEmail("en", request);
    expect(en.subject).toBe("Ada asked for access to “Bütçe”");
    expect(en.text).toContain("Ada (ada@example.com) would like to open “Bütçe” in Ekip.");
    expect(en.text).toContain("Their message: “Need it for <the> review”");
    expect(en.html).toContain("Need it for &lt;the&gt; review");
    expect(en.text).toContain(`Open page: ${link}`);

    const bare = accessRequestEmail("tr", { ...request, requesterName: "", message: null });
    expect(bare.subject).toBe("ada@example.com “Bütçe” sayfasına erişim istedi");
    expect(bare.text).not.toContain("Mesajı");
  });

  it("tells the requester what they can do now", () => {
    const approved = accessApprovedEmail("en", { actorName: "Erhan", pageTitle: "Bütçe", workspaceName: "Ekip", level: "comment", link });
    expect(approved.subject).toBe("You can now open “Bütçe”");
    expect(approved.text).toContain("Erhan approved your request");
    expect(approved.text).toContain("You can now view and comment on “Bütçe” in Ekip.");
  });

  it("declines without naming the page, its workspace or who declined", () => {
    const declined = accessDeclinedEmail("en", { link });
    expect(declined.subject).toBe("Your request for access was declined");
    expect(declined.text).toContain(link);
    for (const leak of ["Bütçe", "Ekip", "Erhan"]) expect(declined.text).not.toContain(leak);
  });
});
