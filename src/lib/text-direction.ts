/**
 * The writing direction of a piece of text, from its first letter: Arabic, Hebrew, Persian and the
 * other right-to-left scripts make it "rtl", any other letter "ltr". Text without letters (empty,
 * digits, punctuation, emoji) has none and takes the direction around it.
 *
 * Page blocks use it so each paragraph runs the way its own text does, whatever the interface
 * language (an Arabic note in an English workspace, an English quote on an Arabic page).
 */

const LETTER = /\p{L}/u;
const RIGHT_TO_LEFT =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;

export function textDirection(text: string): "ltr" | "rtl" | null {
  const letter = LETTER.exec(text)?.[0];
  if (!letter) return null;
  return RIGHT_TO_LEFT.test(letter) ? "rtl" : "ltr";
}
