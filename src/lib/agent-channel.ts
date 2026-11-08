/**
 * What an agent mentioned in a channel of Messages reads of its thread (server/agents/run.ts): the
 * messages before the one that mentioned it, oldest first, one line each with its writer's name,
 * the newest kept when they don't all fit. Pure.
 */
import { plainText } from "./message-text";

type ThreadMessage = { id: string; authorId: string | null; kind: "message" | "system"; body: string; deletedAt: string | Date | null };

export function channelThreadBefore(
  messages: readonly ThreadMessage[],
  messageId: string,
  nameOf: (userId: string | null) => string,
  { max, chars }: { max: number; chars: number },
): string[] {
  const at = messages.findIndex((m) => m.id === messageId);
  const before = at < 0 ? messages : messages.slice(0, at);
  const lines = before
    .filter((m) => m.kind === "message" && !m.deletedAt && m.body.trim())
    .slice(-max)
    .map((m) => `${nameOf(m.authorId)}: ${plainText(m.body).replace(/\n+/g, " ").trim()}`);
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i].length + 1;
    if (used > chars) break;
    kept.unshift(lines[i]);
  }
  return kept;
}
