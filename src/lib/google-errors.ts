/**
 * Whether an error a Google tool answered with (through a workspace's Sheets or Calendar
 * connection, whose answers are text) is one that passes: a spent quota or rate limit, or Google
 * being down or slow for a while. Such an answer can say 403 too (`rateLimitExceeded`), so it is
 * asked before the words that would pause a sync (lib/jira-sync pausesJiraSync).
 */
export function googleTriesLater(said: string): boolean {
  return /\b(?:429|500|502|503|504)\b|quota|rate.?limit|resource.?exhausted|backend.?error|internal.?error|unavailable|deadline.?exceeded|timed?.?out|try again|temporar/i.test(said);
}
