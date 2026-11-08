/** A task's title from a message (server/messages/to-task.ts): its first line, cut at a word to fit. */
export function taskTitle(text: string, max = 120): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
