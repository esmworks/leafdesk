/**
 * Folds text for case-insensitive matching (pickers, database filters, form conditions, option
 * names): lower-cased, with the dotted and dotless i treated alike, so "ist" finds "İstanbul" and
 * "ılık" finds "ILIK". Browsers in a Turkish locale don't lower-case "I" the same way every time
 * (typed text can become "ı" while the same letters in loaded data become "i"), so a name typed
 * as it is shown must still match.
 */
export function searchFold(text: string) {
  return text.toLocaleLowerCase().replace(/ı/g, "i").replace(/̇/g, "");
}
