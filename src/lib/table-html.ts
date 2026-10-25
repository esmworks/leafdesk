/**
 * A table as a page of its own (the HTML export of a database view): the title as its heading,
 * then the cells, header first. Everything is escaped; the page loads nothing.
 */

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const STYLE = [
  "body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;margin:2rem;color:#1f2023}",
  "h1{font-size:1.5rem;margin:0 0 1rem}",
  "table{border-collapse:collapse;font-size:.875rem}",
  "th,td{border:1px solid #e4e4e7;padding:.375rem .625rem;text-align:start;vertical-align:top;white-space:pre-wrap}",
  "th{background:#f7f7f8;font-weight:600}",
  "td.number{text-align:end;font-variant-numeric:tabular-nums}",
].join("");

export function tableHtml(title: string, header: string[], cells: (string | number | null)[][], lang = "en"): string {
  const row = (values: (string | number | null)[], tag: "th" | "td") =>
    `<tr>${values
      .map((value) => {
        const number = tag === "td" && typeof value === "number";
        return `<${tag} dir="auto"${number ? ' class="number"' : ""}>${escape(value === null ? "" : String(value))}</${tag}>`;
      })
      .join("")}</tr>`;
  return [
    `<!doctype html>`,
    `<html lang="${escape(lang)}">`,
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>${STYLE}</style></head>`,
    `<body>`,
    `<h1 dir="auto">${escape(title)}</h1>`,
    `<table><thead>${row(header, "th")}</thead><tbody>${cells.map((cell) => row(cell, "td")).join("")}</tbody></table>`,
    `</body>`,
    `</html>`,
    "",
  ].join("\n");
}
