import { cleanHtmlSource, htmlAnswer } from "@/lib/html-block";
import { AiError, complete, type AiMessage } from "@/server/ai";
import { externalData } from "@/server/ai/frame";
import { editablePage } from "@/server/ai-writing";

/** The longest instruction an editor gives. */
export const MAX_HTML_INSTRUCTION = 2_000;

const SYSTEM = [
  "You write small interactive web apps for Leafdesk, a workspace app: one self-contained HTML document that runs inside a page (a calculator, a form that adds things up, a quiz, a chart, an org chart, a timer).",
  "Answer with the whole HTML document and nothing else: no explanation, no Markdown around it.",
  "Rules of the sandbox the document runs in:",
  "- Everything is inline: CSS in a <style> element, JavaScript in a <script> element. Nothing loads from outside: no external scripts, stylesheets, fonts, images or frames, no fetch, XHR or WebSocket. Draw charts with inline SVG or <canvas> and your own code. Images may only be data: URIs.",
  "- No localStorage, sessionStorage, cookies or IndexedDB (the sandbox has no storage), no alert, confirm or prompt, no popups, no links to other sites and no form submission to a server: handle inputs and buttons with JavaScript.",
  "- Keep state in JavaScript variables. It resets when the page reloads.",
  "Make it look right in a page: no outer margins to speak of, a transparent background, font-family system-ui, a readable size, and colors that work in light and dark mode (use @media (prefers-color-scheme: dark) or colors that read on both). It must fit narrow widths (it may be shown 320px wide) and grow with its content; do not use viewport units for height.",
  "Write the texts the app shows in the language of the request. Keep it simple and working: no placeholders, no TODOs.",
].join("\n");

/**
 * The HTML of an HTML block written, or changed from `current`, as an editor of the page asks
 * (`instruction`), through the model. Nothing is saved: the editor offers it first. Throws
 * AiError("noAccess") when `userId` may not edit the page, "disabled" without AI, "invalid" when
 * the instruction is empty or the answer holds no usable document.
 */
export async function writeHtmlBlock(
  userId: string,
  pageId: string,
  { current, instruction }: { current: string; instruction: string },
  { signal }: { signal?: AbortSignal } = {},
): Promise<string> {
  const found = await editablePage(userId, pageId);
  const asked = instruction.trim().slice(0, MAX_HTML_INSTRUCTION);
  if (!asked) throw new AiError("invalid", "Say what the app should do");
  const source = cleanHtmlSource(current);
  const messages: AiMessage[] = [
    {
      role: "user",
      content: [
        // The block's source is page content others may have written: data, never instructions.
        source.trim() ? externalData("This is the HTML of the app as it is now.", source) : "There is no app yet.",
        `What to ${source.trim() ? "change" : "write"}:\n${asked}`,
        source.trim() ? "Answer with the whole changed document." : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];
  const result = await complete({ feature: "html.block", userId, workspaceId: found.workspaceId, system: SYSTEM, messages, signal });
  const html = htmlAnswer(result.text);
  if (!html) throw new AiError("invalid", "The AI's answer holds no usable HTML");
  return html;
}
