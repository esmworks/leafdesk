// Client-safe: an uploaded meeting recording (components/voice/meeting-upload-session.ts), apart
// from lib/meetings so the session that loads on its own carries only this.

import { MEETING_CHUNK_SECONDS } from "./meeting-clock";
import { VOICE_ACCEPT, voiceAudioType } from "./voice-notes";

/**
 * A recording made elsewhere is read in the browser (decoded to one channel at this rate, which
 * speech to text needs no more than) and sent in the pieces a live recording is sent in, each as
 * a WAV file: the audio is never uploaded whole, nor kept.
 */
export const UPLOAD_SAMPLE_RATE = 16_000;

/** The largest file read: it is decoded whole in the browser's memory. */
export const MAX_MEETING_FILE_BYTES = 500 * 1024 * 1024;

/** What the file picker offers: what voice notes take, and videos, whose sound is read. */
export const MEETING_FILE_ACCEPT = `${VOICE_ACCEPT},.mov,video/mp4,video/webm,video/quicktime`;

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

/** Whether a file may be a recording to read: a supported audio type or extension, or a video. */
export function isMeetingFile(file: { type: string; name: string }): boolean {
  if (voiceAudioType(file.type, file.name)) return true;
  const type = file.type.split(";")[0].trim().toLowerCase();
  return type.startsWith("audio/") || VIDEO_TYPES.has(type) || /\.mov$/i.test(file.name.trim());
}

/** Bytes a WAV file's header takes. */
const WAV_HEADER = 44;

/**
 * How long each piece of an uploaded recording is: as long as a live recording's, shorter when the
 * server's speech to text takes smaller files (two bytes a sample).
 */
export function uploadPieceSeconds(maxBytes: number): number {
  const fits = Math.floor((maxBytes - WAV_HEADER) / (UPLOAD_SAMPLE_RATE * 2));
  return Math.max(1, Math.min(MEETING_CHUNK_SECONDS, fits));
}

export type UploadPiece = { chunk: number; offset: number; duration: number };

/**
 * The pieces of a recording `seconds` long, each `pieceSeconds` (the last one shorter), numbered
 * from `firstChunk` and placed from `startAt` seconds into the meeting.
 */
export function uploadPieces(seconds: number, pieceSeconds: number, { firstChunk = 0, startAt = 0 }: { firstChunk?: number; startAt?: number } = {}): UploadPiece[] {
  const pieces: UploadPiece[] = [];
  if (!(seconds > 0) || !(pieceSeconds > 0)) return pieces;
  for (let from = 0, n = 0; from < seconds - 0.05; from += pieceSeconds, n++) {
    const duration = Math.round(Math.min(pieceSeconds, seconds - from) * 10) / 10;
    pieces.push({ chunk: firstChunk + n, offset: Math.round((startAt + from) * 10) / 10, duration });
  }
  return pieces;
}

/** One channel out of several, averaged; the channel itself when there is only one. */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = Math.min(...channels.map((c) => c.length));
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i];
  for (let i = 0; i < length; i++) mono[i] /= channels.length;
  return mono;
}

/** Samples (-1…1) as a 16-bit mono WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(WAV_HEADER + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // one channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(WAV_HEADER + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}
