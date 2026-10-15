// Client-safe: shared by the voice note recorder, its route and the server code (server/voice-notes).

/**
 * Audio a voice note may be, by media type (parameters such as `;codecs=opus` dropped), with the
 * file extension it is sent under: transcription servers tell formats apart by the name.
 * Recorders give webm (Chrome, Firefox, Android), mp4 (Safari, iOS) or ogg.
 */
export const VOICE_AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

/** What the file picker offers. */
export const VOICE_ACCEPT = ".webm,.ogg,.oga,.opus,.m4a,.mp4,.mp3,.mpeg,.mpga,.wav,.flac,audio/*";

const EXTENSION_TYPES: Record<string, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mp3: "audio/mpeg",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
};

/**
 * The media type a voice note's audio is handled as: the declared one when it is a supported
 * type, else a guess from the file name's extension (phones often label files
 * application/octet-stream). Null for anything else.
 */
export function voiceAudioType(declared: string | null | undefined, name?: string | null): string | null {
  const type = (declared ?? "").split(";")[0].trim().toLowerCase();
  if (Object.hasOwn(VOICE_AUDIO_TYPES, type)) return type;
  const ext = name?.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return Object.hasOwn(EXTENSION_TYPES, ext) ? EXTENSION_TYPES[ext] : null;
}

/** The file name audio of a supported type is sent to the transcription server under. */
export function voiceFileName(type: string): string {
  return `voice-note.${VOICE_AUDIO_TYPES[type] ?? "webm"}`;
}

/**
 * The recording formats to ask a browser's recorder for, best first: Opus in WebM where it can
 * (small, and every transcription server reads it), MP4/AAC on Safari.
 */
export const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"] as const;

/** Bit rate the recorder is asked for: speech stays clear and ten minutes stay under 3 MB. */
export const RECORDER_BITS_PER_SECOND = 32_000;

/** What the browser needs to know about voice notes: null when the server can't transcribe. */
export type VoiceNoteLimits = { maxSeconds: number; maxBytes: number };

/** A select or multi-select property a voice note row may fill, with its option names. */
export type VoiceNoteTagProperty = { id: string; name: string; multiple: boolean; options: string[] };

/**
 * A voice note as the server wrote it up, before it is saved (the quick note) or inserted at the
 * cursor (the editor). `properties`: values for the target database's select and multi-select
 * properties, by property id, as option names that exist. `rewritten` is false when the AI wasn't
 * available or failed and `markdown` is the transcript as it came.
 */
export type VoiceNoteDraft = {
  title: string;
  markdown: string;
  transcript: string;
  properties: Record<string, string | string[]>;
  rewritten: boolean;
};

/** "1:05" for 65 seconds. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Longest transcript kept with a note (the raw text under the note). */
export const MAX_TRANSCRIPT = 100_000;

/** The toggle block under a note that holds what was said, one paragraph per line of the transcript. */
export function transcriptBlock(transcript: string, label: string) {
  const paragraphs = transcript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    type: "toggleListItem",
    content: label,
    children: paragraphs.map((text) => ({ type: "paragraph", content: text })),
  };
}

/**
 * The values a note's row gets from what the AI picked: by property id, only options that exist
 * (matched without regard to case, given as the option's own name), one for a select.
 */
export function pickTagValues(tags: Record<string, string[]>, properties: VoiceNoteTagProperty[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, values] of Object.entries(tags)) {
    const prop = properties.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!prop) continue;
    const picked = [
      ...new Set(values.flatMap((v) => prop.options.find((o) => o.trim().toLowerCase() === v.trim().toLowerCase()) ?? [])),
    ];
    if (!picked.length) continue;
    out[prop.id] = prop.multiple ? picked : picked[0];
  }
  return out;
}

/** A note's own headings, put under its title (a level 2 heading) when it goes into a page. */
export function demoteHeadings(markdown: string): string {
  return markdown.replace(/^#{1,2}(\s)/gm, "###$1");
}
