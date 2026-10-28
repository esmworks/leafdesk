import { describe, expect, it } from "vitest";
import { encodeWav, isMeetingFile, mixToMono, UPLOAD_SAMPLE_RATE, uploadPieces, uploadPieceSeconds } from "./meeting-upload";

describe("uploaded meeting recordings", () => {
  it("take audio files, by type or name, and videos", () => {
    expect(isMeetingFile({ type: "audio/mp4", name: "standup.m4a" })).toBe(true);
    expect(isMeetingFile({ type: "application/octet-stream", name: "call.mp3" })).toBe(true);
    expect(isMeetingFile({ type: "audio/aac", name: "call.aac" })).toBe(true);
    expect(isMeetingFile({ type: "video/mp4", name: "review.mp4" })).toBe(true);
    expect(isMeetingFile({ type: "", name: "Screen recording.MOV" })).toBe(true);
    expect(isMeetingFile({ type: "application/pdf", name: "agenda.pdf" })).toBe(false);
    expect(isMeetingFile({ type: "image/png", name: "slide.png" })).toBe(false);
  });

  it("are cut into pieces as long as a live recording's, placed after what is there", () => {
    expect(uploadPieces(75, 30)).toEqual([
      { chunk: 0, offset: 0, duration: 30 },
      { chunk: 1, offset: 30, duration: 30 },
      { chunk: 2, offset: 60, duration: 15 },
    ]);
    expect(uploadPieces(60, 30, { firstChunk: 4, startAt: 120 })).toEqual([
      { chunk: 4, offset: 120, duration: 30 },
      { chunk: 5, offset: 150, duration: 30 },
    ]);
    // A rounding crumb at the end makes no piece of its own.
    expect(uploadPieces(60.02, 30)).toHaveLength(2);
    expect(uploadPieces(0, 30)).toEqual([]);
    expect(uploadPieces(Number.NaN, 30)).toEqual([]);
  });

  it("make pieces that fit the server's speech to text", () => {
    expect(uploadPieceSeconds(25 * 1024 * 1024)).toBe(30);
    // Two bytes a sample at 16 kHz: 320 KB is ten seconds.
    expect(uploadPieceSeconds(44 + UPLOAD_SAMPLE_RATE * 2 * 10)).toBe(10);
    expect(uploadPieceSeconds(100)).toBe(1);
  });

  it("mix channels into one", () => {
    const left = new Float32Array([1, 0.5, -1]);
    expect(mixToMono([left])).toBe(left);
    expect(Array.from(mixToMono([left, new Float32Array([0, 0.5, 1])]))).toEqual([0.5, 0.5, 0]);
  });

  it("write 16-bit mono WAV files", () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 2]), 16_000);
    const view = new DataView(bytes.buffer);
    const text = (at: number, length: number) => String.fromCharCode(...bytes.slice(at, at + length));
    expect(bytes.length).toBe(44 + 8);
    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(36 + 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(8);
    // Clipped to the range a sample holds.
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });
});
