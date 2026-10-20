import { describe, expect, it } from "vitest";
import {
  cleanVoiceNoteInstructions,
  demoteHeadings,
  formatDuration,
  MAX_VOICE_NOTE_INSTRUCTIONS,
  pickTagValues,
  transcriptBlock,
  voiceAudioType,
  voiceFileName,
} from "./voice-notes";

describe("voice note audio", () => {
  it("takes what recorders and phones declare, and guesses from the name otherwise", () => {
    expect(voiceAudioType("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(voiceAudioType("audio/mp4")).toBe("audio/mp4");
    expect(voiceAudioType("application/octet-stream", "Memo 12.m4a")).toBe("audio/mp4");
    expect(voiceAudioType("", "call.MP3")).toBe("audio/mpeg");
    expect(voiceAudioType("image/png", "photo.png")).toBeNull();
    expect(voiceAudioType("text/html", "page.html")).toBeNull();
  });

  it("names the file after its format, which transcription servers go by", () => {
    expect(voiceFileName("audio/webm")).toBe("voice-note.webm");
    expect(voiceFileName("audio/mp4")).toBe("voice-note.m4a");
    expect(voiceFileName("audio/ogg")).toBe("voice-note.ogg");
  });

  it("shows durations as minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65.7)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });
});

describe("voice note blocks", () => {
  it("keeps the transcript in a toggle, a paragraph per line", () => {
    expect(transcriptBlock("First line.\n\nSecond line.\n", "Transcript")).toEqual({
      type: "toggleListItem",
      content: "Transcript",
      children: [
        { type: "paragraph", content: "First line." },
        { type: "paragraph", content: "Second line." },
      ],
    });
  });

  it("puts the note's headings under its title", () => {
    expect(demoteHeadings("# Plan\ntext\n## Next\n### Kept\nnot # a heading")).toBe("### Plan\ntext\n### Next\n### Kept\nnot # a heading");
  });
});

describe("pickTagValues", () => {
  const properties = [
    { id: "p1", name: "Tags", multiple: true, options: ["Work", "Ideas", "Home"] },
    { id: "p2", name: "Priority", multiple: false, options: ["High", "Low"] },
  ];

  it("keeps only options that exist, under the option's own name, by property id", () => {
    expect(pickTagValues({ tags: ["work", "Ideas", "Garden"], " priority ": ["low", "High"] }, properties)).toEqual({
      p1: ["Work", "Ideas"],
      p2: "Low",
    });
  });

  it("leaves out unknown properties and properties where nothing fits", () => {
    expect(pickTagValues({ Status: ["Done"], Tags: ["Garden"] }, properties)).toEqual({});
  });
});

describe("voice note instructions", () => {
  it("are stored trimmed, with tidy line ends, and cut at the limit", () => {
    expect(cleanVoiceNoteInstructions("  Company\r\nPerson met\r\n\r\n\r\n\r\nNext step  ")).toBe("Company\nPerson met\n\nNext step");
    expect(cleanVoiceNoteInstructions(" \n ")).toBe("");
    expect(cleanVoiceNoteInstructions("x".repeat(MAX_VOICE_NOTE_INSTRUCTIONS + 50))).toHaveLength(MAX_VOICE_NOTE_INSTRUCTIONS);
  });
});
