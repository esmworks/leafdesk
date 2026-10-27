import type { PdfTheme } from "@/lib/pdf-themes";

/**
 * A theme to start from (lib/pdf-themes): a one-page quote. Its words come from the person's
 * language (settings.letterheads.starter); the property names it reads (`{{property:Customer}}` …)
 * are those words too, so it fills in from a quotes database whose columns are named that way,
 * and is changed to read others in a moment, by hand or by the AI.
 *
 * Pure and client-safe.
 */

export const STARTER_LABELS = [
  "quote",
  "quoteNo",
  "customer",
  "contact",
  "address",
  "phone",
  "date",
  "validUntil",
  "currency",
  "subtotal",
  "tax",
  "total",
  "preparedBy",
  "terms",
  "term1",
  "term2",
  "approval",
  "approvalCompany",
  "approvalName",
  "approvalSignature",
] as const;
export type StarterLabels = Record<(typeof STARTER_LABELS)[number], string>;

export function starterTheme(l: StarterLabels): PdfTheme {
  const property = (name: string) => `{{property:${name}}}`;
  const fields = (rows: string[]) => ({
    type: "fields" as const,
    label_caps: true,
    value_bold: true,
    label_width: 70,
    size: 8,
    padding: 2.5,
    rows: rows.map((name) => ({ label: name, value: property(name) })),
  });
  const heading = (text: string) => ({ type: "text" as const, text, caps: true, bold: true, size: 7.5, color: "accent" as const, letter_spacing: 0.8, after: 4 });
  return {
    colors: { accent: "#003399", text: "#1e293b", muted: "#64748b", border: "#e2e8f0", fill: "#f8fafc" },
    margins: { top: 30, right: 40, bottom: 44, left: 40 },
    font_size: 8.75,
    title: false,
    headings: { color: "accent" },
    tables: { header_fill: "accent", header_color: "white", stripes: "fill", lines: "rows", size: 8.25 },
    content: [
      {
        type: "columns",
        after: 6,
        columns: [
          { width: 130, items: [{ type: "logo", height: 30, width: 130 }] },
          { items: [{ type: "text", text: "{{workspace}}", bold: true, caps: true, color: "accent", size: 9, align: "right" }] },
        ],
      },
      { type: "rule", color: "accent", thickness: 1.5, after: 12 },
      {
        type: "columns",
        after: 10,
        columns: [
          {
            items: [
              { type: "text", text: l.quote, size: 15, bold: true, color: "accent", after: 1 },
              { type: "text", text: "{{title}}", size: 8.5, color: "muted" },
            ],
          },
          {
            width: 130,
            items: [
              {
                type: "box",
                fill: "#eff6ff",
                border: "#dbeafe",
                padding: 5,
                items: [
                  { type: "text", text: l.quoteNo, caps: true, size: 6, bold: true, color: "muted", letter_spacing: 1, align: "right" },
                  { type: "text", text: property(l.quoteNo), size: 10, bold: true, color: "accent", align: "right" },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "columns",
        gap: 12,
        after: 12,
        columns: [{ items: [fields([l.customer, l.contact, l.address, l.phone])] }, { width: 190, items: [fields([l.date, l.validUntil, l.currency])] }],
      },
      { type: "body" },
      {
        type: "columns",
        after: 14,
        columns: [
          { items: [] },
          {
            width: 190,
            items: [
              {
                type: "fields",
                label_width: 90,
                size: 8.5,
                value_bold: true,
                after: 0,
                rows: [
                  { label: l.subtotal, value: property(l.subtotal) },
                  { label: l.tax, value: property(l.tax) },
                ],
              },
              {
                type: "box",
                fill: "accent",
                padding: 7,
                items: [
                  {
                    type: "columns",
                    after: 0,
                    columns: [
                      { items: [{ type: "text", text: l.total, bold: true, color: "white", size: 9 }] },
                      { width: "auto", items: [{ type: "text", text: property(l.total), bold: true, color: "white", size: 11.25, align: "right" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      heading(l.terms),
      { type: "list", numbered: true, size: 7.5, color: "muted", after: 18, items: [l.term1, l.term2] },
      {
        type: "columns",
        gap: 28,
        after: 0,
        columns: [
          { items: [heading(l.approval), { type: "blanks", columns: 2, height: 28, labels: [l.approvalCompany, l.approvalName, l.date, l.approvalSignature] }] },
          { width: 170, items: [{ type: "space", height: 34 }, { type: "signature", width: 170, lines: [property(l.preparedBy), "{{workspace}}"] }] },
        ],
      },
    ],
    footer: [
      { type: "rule", color: "border", thickness: 0.6, after: 4 },
      {
        type: "columns",
        after: 0,
        columns: [
          { items: [{ type: "text", text: "{{workspace}} · {{date}}", size: 6.75 }] },
          { width: 60, items: [{ type: "text", text: "{{page}} / {{pages}}", size: 6.75, align: "right" }] },
        ],
      },
    ],
  };
}

/** The starter's words in English, for the docs topic's example. */
export const ENGLISH_STARTER_LABELS: StarterLabels = {
  quote: "Quote",
  quoteNo: "Quote no",
  customer: "Customer",
  contact: "Contact",
  address: "Address",
  phone: "Phone",
  date: "Date",
  validUntil: "Valid until",
  currency: "Currency",
  subtotal: "Subtotal",
  tax: "Tax",
  total: "Total",
  preparedBy: "Prepared by",
  terms: "Terms",
  term1: "Prices exclude tax unless stated otherwise.",
  term2: "Once accepted, this quote becomes an order.",
  approval: "Acceptance",
  approvalCompany: "Company / stamp",
  approvalName: "Name",
  approvalSignature: "Signature",
};
