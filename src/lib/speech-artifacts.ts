/**
 * Lines speech-to-text models write without anyone saying them. Whisper learned from subtitled
 * videos, so on silence, noise or a mumbled stretch it can put in a subtitler's credit or a
 * video's sign-off ("don't forget to subscribe"), in the language it was told. These were seen
 * from large-v3-turbo on silence and noise in each interface language, and in recordings.
 * Thanks alone ("Thank you.", "Kiitos.") is left: people say it.
 */

/** Credits and sign-offs nobody dictates into a workspace: dropped wherever they appear. */
const ANYWHERE: RegExp[] = [
  // tr
  /altyazı\s+m\.\s?k\./giu,
  /(?:(?:kanal(?:ım)?a\s+)?abone\s+olmayı|(?:videoyu\s+)?beğenmeyi)(?:(?:\s*,\s*|\s+ve\s+)(?:(?:kanal(?:ım)?a\s+)?abone\s+olmayı|(?:videoyu\s+)?beğenmeyi))*\s+unutmayın/giu,
  /[iİ]zlediğiniz\s+için\s+teşekkür(?:ler|\s+ederim|\s+ederiz)/giu,
  // en
  /(?:thanks|thank\s+you)\s+(?:so\s+much\s+)?for\s+watching/giu,
  /subtitles\s+by\s+the\s+amara\.org\s+community/giu,
  // de
  /untertitel(?:ung)?\s+(?:des|im\s+auftrag\s+des)\s+zdf(?:\s+für\s+funk)?(?:,?\s*\d{4})?/giu,
  /untertitel\s+der\s+amara\.org-community/giu,
  // fr
  /sous-titres\s+réalisés\s+par\s+la\s+communauté\s+d['’]amara\.org/giu,
  /sous-titrage\s+(?:st['’]?\s*\d+|fr\s*\?|société\s+radio-canada)/giu,
  // es, pt, pl, uk
  /gracias\s+por\s+ver\s+el\s+v[ií]deo/giu,
  /obrigad[oa]\s+por\s+assistir/giu,
  /dzięki\s+za\s+oglądanie/giu,
  /дякую\s+за\s+перегляд/giu,
  // da, no, sv
  /danske\s+tekster\s+af\s+nicolai\s+winther/giu,
  /teksting\s+av\s+nicolai\s+winther/giu,
  /textning\s+stina\s+hedin(?:\s+www\.btistudios\.com)?/giu,
  /tack\s+till\s+elever\s+och\s+personer\s+som\s+hjälpte\s+med\s+videon/giu,
  // ar
  /ترجمة\s+نانسي\s+قنقر/gu,
  /اشتركوا\s+في\s+القناة/gu,
  // ja, ko, zh
  /ご視聴ありがとうございました/gu,
  /다음\s*영상에서\s*만나요/gu,
  /한글자막\s*by\s*\S+/giu,
  /字幕志愿者\s*\S+/gu,
  /感谢观看/gu,
  /优优独播剧场\s*——\s*YoYo\s+Television\s+Series\s+Exclusive/giu,
  // vi
  /cảm\s+ơn\s+các\s+bạn\s+đã\s+theo\s+dõi(?:\s+và\s+hẹn\s+gặp\s+lại)?/giu,
  /hẹn\s+gặp\s+lại\s+các\s+bạn\s+trong\s+những\s+video\s+tiếp\s+theo/giu,
];

/** Things a person may say, but which mean nothing was heard when they are the whole text. */
const ALONE: RegExp[] = [/^продолжение\s+следует\.*$/iu, /^pym\s+jbz$/iu, /^\*+$/u];

/** Punctuation left behind where an artifact was cut out of a sentence. */
const LOOSE_START = /^[\s,;:.!?…—–-]+/u;
const LOOSE_END = /[\s,;:—–-]+$/u;

/**
 * `text` without the artifacts above, and what was dropped (for the log). Text that was only an
 * artifact comes back empty.
 */
export function dropSpeechArtifacts(text: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  let rest = text;
  for (const pattern of ANYWHERE) {
    // The sentence's own closing marks go with it.
    rest = rest.replace(new RegExp(`${pattern.source}[.!?…]*`, pattern.flags), (found) => {
      dropped.push(found);
      return " ";
    });
  }
  // Untouched text stays exactly as it came.
  rest = dropped.length
    ? rest.replace(/\s+/gu, " ").replace(/\s+([,.!?;:])/gu, "$1").replace(LOOSE_START, "").replace(LOOSE_END, "")
    : rest.trim();
  if (ALONE.some((pattern) => pattern.test(rest))) {
    dropped.push(rest);
    rest = "";
  }
  // Only marks left ("." after "Altyazı M.K."): nothing was said.
  if (!/[\p{L}\p{N}]/u.test(rest)) rest = "";
  return { text: rest, dropped };
}
