import { textQuoteStart, type MailBody } from "@/lib/mail-client";

/** A message as printed: its lines over the body, already worded, and the body as the tab read it. */
export type PrintedMessage = { lines: string[]; body: MailBody; files: string[] };

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The frame of the print before, taken away when the next one starts if the browser never said it was done.
let last: HTMLIFrameElement | null = null;

/**
 * Prints messages on paper, nothing of the page around them: a document of their own, with the
 * subject over them and each one's sender, recipients and date, in a frame out of sight that is
 * printed and taken away. The HTML is the one cleaned on the server, as the tab shows it (images
 * from other sites only where they are shown); each message's styles hold to its own section. As
 * in the message's frame, nothing in it runs: the sandbox lets it be measured and printed only.
 * With `quoted`, the earlier mail a message quotes is printed too (one message, not a conversation).
 */
export function printMail({ subject, messages, quoted }: { subject: string; messages: PrintedMessage[]; quoted: boolean }) {
  const parser = new DOMParser();
  const styles: string[] = [];
  const sections = messages.map(({ lines, body, files }, i) => {
    let content: string;
    if (body.html) {
      const html = parser.parseFromString(body.html, "text/html");
      for (const style of html.head.querySelectorAll("style")) styles.push(`@scope (#m${i}) {\n${style.textContent ?? ""}\n}`);
      content = html.body.innerHTML + (quoted && body.quotedHtml ? parser.parseFromString(body.quotedHtml, "text/html").body.innerHTML : "");
    } else {
      const all = body.text.replace(/\r\n/g, "\n").split("\n");
      const cut = quoted ? -1 : textQuoteStart(all);
      content = `<div class="text">${escape((cut >= 0 ? all.slice(0, cut) : all).join("\n").trimEnd())}</div>`;
    }
    return `<section id="m${i}"><header>${lines.map((line, n) => `<div${n === 0 ? ' class="from"' : ""}>${escape(line)}</div>`).join("")}</header><div class="body">${content}</div>${
      files.length ? `<ul class="files">${files.map((name) => `<li>${escape(name)}</li>`).join("")}</ul>` : ""
    }</section>`;
  });
  const images = messages.some((m) => m.body.html && m.body.images);
  const policy = `default-src 'none'; img-src data:${images ? " https: http:" : ""}; style-src 'unsafe-inline'; font-src data:`;
  const page = document.documentElement;
  const doc = `<!doctype html><html lang="${escape(page.lang)}" dir="${escape(page.dir || "ltr")}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>${escape(subject)}</title><style>
    @page{margin:16mm}html{color-scheme:light}body{margin:0;font:12pt/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff;overflow-wrap:anywhere}
    h1{font-size:16pt;margin:0 0 12pt}section{padding-top:10pt;border-top:1px solid #999}section+section{margin-top:16pt}
    header{margin-bottom:10pt;font-size:10pt;color:#333}header .from{font-weight:600;color:#000}
    img{max-width:100%;height:auto}[data-blocked]{display:none!important}table{max-width:100%}pre,.text{white-space:pre-wrap}
    blockquote{margin:0 0 0 .8em;padding-left:.8em;border-left:2px solid #bbb;color:#444}.files{margin:10pt 0 0;padding-inline-start:16pt;font-size:10pt;color:#333}
  </style>${styles.map((css) => `<style>${css}</style>`).join("")}</head><body><h1>${escape(subject)}</h1>${sections.join("")}</body></html>`;

  last?.remove();
  const frame = document.createElement("iframe");
  last = frame;
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;bottom:0;right:0;width:0;height:0;border:0";
  frame.srcdoc = doc;
  frame.addEventListener("load", () => {
    const win = frame.contentWindow;
    if (!win) return;
    const done = () => {
      frame.remove();
      if (last === frame) last = null;
    };
    win.addEventListener("afterprint", done);
    // Pictures still coming in would print as empty boxes: printed once they are in, or after a few seconds.
    const pending = [...(frame.contentDocument?.images ?? [])].filter((img) => !img.complete);
    const loaded = Promise.all(
      pending.map(
        (img) =>
          new Promise((settle) => {
            img.addEventListener("load", settle);
            img.addEventListener("error", settle);
          }),
      ),
    );
    void Promise.race([loaded, new Promise((settle) => setTimeout(settle, 3000))]).then(() => win.print());
  });
  document.body.append(frame);
}
