import { describe, expect, it } from "vitest";
import { MAX_UTTERANCE, parseRate, pickVoice, splitForSpeech } from "./read-aloud";

describe("splitForSpeech", () => {
  it("keeps short text whole and drops empty text", () => {
    expect(splitForSpeech("  Hello\n world  ")).toEqual(["Hello world"]);
    expect(splitForSpeech(" \n ")).toEqual([]);
  });

  it("cuts long text at sentence ends, then commas, then spaces", () => {
    const sentence = "This is a sentence of some length. ";
    const pieces = splitForSpeech(sentence.repeat(20));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(MAX_UTTERANCE);
      expect(p.endsWith(".")).toBe(true);
    }
    expect(splitForSpeech("one two, three four", 12)).toEqual(["one two,", "three four"]);
    expect(splitForSpeech("aaaa bbbb cccc dddd", 10)).toEqual(["aaaa bbbb", "cccc dddd"]);
  });

  it("cuts inside a word only when there is no other place", () => {
    expect(splitForSpeech("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("cuts at CJK sentence ends without spaces", () => {
    expect(splitForSpeech("今日は晴れです。明日は雨です。", 10)).toEqual(["今日は晴れです。", "明日は雨です。"]);
  });

  it("keeps every word", () => {
    const text = Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ");
    expect(splitForSpeech(text).join(" ")).toBe(text);
  });
});

describe("pickVoice", () => {
  const voices = [
    { voiceURI: "en-us", lang: "en-US", default: true, localService: true },
    { voiceURI: "tr-net", lang: "tr-TR", default: false, localService: false },
    { voiceURI: "tr-local", lang: "tr_TR", default: false, localService: true },
    { voiceURI: "de", lang: "de-DE", default: false, localService: true },
  ];

  it("keeps the voice chosen before", () => {
    expect(pickVoice(voices, "tr", "de")?.voiceURI).toBe("de");
  });

  it("matches the language, a voice on the device first", () => {
    expect(pickVoice(voices, "tr")?.voiceURI).toBe("tr-local");
    expect(pickVoice(voices, "de-AT")?.voiceURI).toBe("de");
    expect(pickVoice(voices, "en-US", "gone")?.voiceURI).toBe("en-us");
  });

  it("falls back to the default voice, or none", () => {
    expect(pickVoice(voices, "ja")?.voiceURI).toBe("en-us");
    expect(pickVoice([], "en")).toBeNull();
  });
});

describe("parseRate", () => {
  it("accepts the offered speeds only", () => {
    expect(parseRate("1.5")).toBe(1.5);
    expect(parseRate(3)).toBe(1);
    expect(parseRate(null)).toBe(1);
  });
});
