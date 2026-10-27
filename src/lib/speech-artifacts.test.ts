import { describe, expect, it } from "vitest";
import { dropSpeechArtifacts } from "./speech-artifacts";

const text = (input: string) => dropSpeechArtifacts(input).text;

describe("dropSpeechArtifacts", () => {
  it("keeps what was said before a video's sign-off", () => {
    expect(dropSpeechArtifacts("Merhaba, abone olmayı ve videoyu beğenmeyi unutmayın.")).toEqual({
      text: "Merhaba",
      dropped: ["abone olmayı ve videoyu beğenmeyi unutmayın."],
    });
    expect(text("Toplantı bitti. Thanks for watching!")).toBe("Toplantı bitti.");
    expect(text("Kanalıma abone olmayı unutmayın. Teklif yarın gidecek.")).toBe("Teklif yarın gidecek.");
  });

  it("empties text that is only an artifact", () => {
    for (const artifact of [
      "Altyazı M.K.",
      "İzlediğiniz için teşekkür ederim.",
      "Untertitelung des ZDF, 2020",
      "Sous-titrage ST' 501",
      "Danske tekster af Nicolai Winther",
      "Textning Stina Hedin www.btistudios.com",
      "ترجمة نانسي قنقر",
      "ご視聴ありがとうございました",
      "한글자막 by 한효정",
      "优优独播剧场——YoYo Television Series Exclusive",
      "Cảm ơn các bạn đã theo dõi và hẹn gặp lại.",
      "Продолжение следует...",
      "***",
    ]) {
      expect(text(artifact), artifact).toBe("");
    }
  });

  it("leaves what people say", () => {
    for (const said of [
      "Merhaba, bu bir deneme.",
      "Thank you.",
      "Kiitos.",
      "Müşteriye abone olmayı önerdik.",
      "Продолжение следует в понедельник.",
      "  Yarın 10'da toplantı var.  ",
    ]) {
      expect(dropSpeechArtifacts(said)).toEqual({ text: said.trim(), dropped: [] });
    }
  });
});
