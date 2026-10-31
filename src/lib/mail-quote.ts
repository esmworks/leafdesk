/**
 * Where a message's text quotes the mail it answers: the thread view folds it away, and the AI
 * reads a thread without it (each message would repeat the ones before).
 */

/**
 * The line the quoted part starts at: the "On … wrote:" line before the first run of ">" lines, or
 * the first of them; -1 when nothing is quoted.
 */
export function quoteStart(lines: readonly string[]): number {
  let cut = lines.findIndex((line) => /^\s*>/.test(line));
  if (cut > 0 && /:\s*$/.test(lines[cut - 1] ?? "")) cut -= 1;
  return cut;
}

/** A message's own words: its text without the mail it quotes. */
export function ownText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = quoteStart(lines);
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n").trim();
}
