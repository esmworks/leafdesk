/**
 * Checks an email an agent wrote before anyone sees it as a draft: it must read as a finished
 * plain-text message someone could send as it is. What it catches is what models tend to leave in:
 * gaps for a person to fill ({{name}}, [Your Name], [insert date]), source numbers ([1]), Markdown
 * and HTML that a mail program would show as symbols, and the app's own ids and markup. A
 * reviewer's own edits aren't checked: they send what they mean to.
 *
 * Shared by the agents' draft_email tool and anything else that has a model write mail.
 */

export type EmailDraftProblem =
  | "emptyText"
  | "subjectLineBreak"
  | "placeholder"
  | "markdown"
  | "html"
  | "internal";

export type EmailDraftCheck = { ok: true } | { ok: false; problems: { problem: EmailDraftProblem; found: string }[] };

const RULES: { problem: EmailDraftProblem; pattern: RegExp }[] = [
  // Gaps to fill: {{name}}, [Your Name], [insert date], and bracketed source numbers like [1].
  { problem: "placeholder", pattern: /\{\{[^{}\n]*\}\}/ },
  { problem: "placeholder", pattern: /\[(?!\s*\])[^[\]\n]{1,60}\](?!\()/ },
  // Markdown: bold, headings, links, tables, code fences.
  { problem: "markdown", pattern: /\*\*[^*\n]+\*\*|__[^_\n]+__/ },
  { problem: "markdown", pattern: /^\s{0,3}#{1,6}\s+\S/m },
  { problem: "markdown", pattern: /\[[^[\]\n]+\]\([^()\s]+\)/ },
  { problem: "markdown", pattern: /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m },
  { problem: "markdown", pattern: /^\s*(```|~~~)/m },
  // HTML tags (a bare "<" or an address in angle brackets is fine).
  { problem: "html", pattern: /<\/?(?:[a-z][a-z0-9]*)(?:\s[^<>]*)?\/?>/i },
  // The app's own ids, links into it and its markup.
  { problem: "internal", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { problem: "internal", pattern: /\/w\/[\w-]+\/p\/[\w-]+/ },
  { problem: "internal", pattern: /<!--\s*leafdesk:/i },
];

/** An address in angle brackets ("Ada <ada@example.com>") isn't a tag. */
const ANGLE_ADDRESS = /<[^<>\s@]+@[^<>\s@]+>/g;

const excerpt = (text: string, index: number, length: number) => text.slice(Math.max(0, index - 10), index + length + 10).replace(/\s+/g, " ").trim();

/** What is wrong with a drafted email, if anything; `subject` and `text` as the model wrote them. */
export function checkEmailDraft({ subject, text }: { subject: string; text: string }): EmailDraftCheck {
  const problems: { problem: EmailDraftProblem; found: string }[] = [];
  if (!text.trim()) problems.push({ problem: "emptyText", found: "" });
  if (/[\r\n]/.test(subject.trim())) problems.push({ problem: "subjectLineBreak", found: subject.trim().split(/[\r\n]/)[0] });
  for (const [part, value] of [
    ["subject", subject],
    ["text", text],
  ] as const) {
    const scanned = value.replace(ANGLE_ADDRESS, (m) => " ".repeat(m.length));
    for (const { problem, pattern } of RULES) {
      const match = pattern.exec(scanned);
      if (!match || problems.some((p) => p.problem === problem)) continue;
      problems.push({ problem, found: excerpt(value, match.index, match[0].length) || part });
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true };
}

const EXPLAIN: Record<EmailDraftProblem, string> = {
  emptyText: "the text is empty",
  subjectLineBreak: "the subject must be one line",
  placeholder: "it has a gap to fill or a source number in brackets (write the real words, or leave the part out)",
  markdown: "it uses Markdown (bold, headings, links, tables or code), which mail shows as symbols: write plain text",
  html: "it has HTML tags: write plain text",
  internal: "it has the app's own ids, links or markup, which mean nothing to the recipient",
};

/** The check's problems as one sentence for the model, with what was found. */
export function explainEmailDraftProblems(check: Extract<EmailDraftCheck, { ok: false }>): string {
  return check.problems.map((p) => (p.found ? `${EXPLAIN[p.problem]} (found: "${p.found}")` : EXPLAIN[p.problem])).join("; ");
}
