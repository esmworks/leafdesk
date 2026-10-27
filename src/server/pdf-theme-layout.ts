import type { Alignment, Content, ContentTable, TableCell, TableLayout } from "pdfmake/interfaces";
import { DEFAULT_THEME_COLORS, fillPlaceholders, type PdfTheme, type ThemeElement, type ThemeValues } from "@/lib/pdf-themes";

/**
 * A PDF theme's elements (lib/pdf-themes) as pdfmake content. Pure: the caller passes the theme's
 * logo already read, as a data URL, and the values its placeholders stand for.
 */

export type ThemePalette = { accent: string; text: string; muted: string; border: string; fill: string };

export function themePalette(theme: PdfTheme): ThemePalette {
  return { ...DEFAULT_THEME_COLORS, ...theme.colors };
}

/** A theme's color as `#rrggbb`: its own, or one of the palette's by name. */
export function themeColor(value: string | undefined, palette: ThemePalette, fallback: string): string {
  if (!value) return fallback;
  if (value === "white") return "#ffffff";
  return value in palette ? palette[value as keyof ThemePalette] : value;
}

export type ThemeLayoutInput = {
  palette: ThemePalette;
  logo: string | null;
  values: ThemeValues;
  /** The page's body, where `{ "type": "body" }` stands. */
  body: Content[];
  fontSize: number;
};

const fill = (text: string, input: ThemeLayoutInput) => fillPlaceholders(text, input.values);
const caps = (text: string, input: ThemeLayoutInput) => text.toLocaleUpperCase(input.values.locale);
const room = (after: number | undefined, fallback = 0): [number, number, number, number] => [0, 0, 0, after ?? fallback];

/** Exactly `height` points of nothing (an empty text would add a line). */
const gap = (height: number): Content => ({ canvas: [{ type: "rect", x: 0, y: 0, w: 1, h: height, lineWidth: 0, fillOpacity: 0, strokeOpacity: 0 }] });

/** A one-cell table: the way to give content a fill and a border that spans its column. */
function cell(stack: Content[], { fillColor, border, borderWidth, padding }: { fillColor?: string; border?: string; borderWidth: number; padding: number }): ContentTable {
  const layout: TableLayout = {
    hLineWidth: () => (border ? borderWidth : 0),
    vLineWidth: () => (border ? borderWidth : 0),
    hLineColor: () => border ?? "#ffffff",
    vLineColor: () => border ?? "#ffffff",
    paddingLeft: () => padding,
    paddingRight: () => padding,
    paddingTop: () => padding,
    paddingBottom: () => padding,
  };
  return { table: { widths: ["*"], body: [[{ stack, ...(fillColor ? { fillColor } : {}) }]] }, layout };
}

function element(e: ThemeElement, input: ThemeLayoutInput): Content[] {
  const { palette } = input;
  switch (e.type) {
    case "body":
      return input.body;
    case "text": {
      const text = fill(e.text, input);
      if (!text.trim()) return [];
      return [
        {
          text: e.caps ? caps(text, input) : text,
          ...(e.size ? { fontSize: e.size } : {}),
          ...(e.bold ? { bold: true } : {}),
          ...(e.italic ? { italics: true } : {}),
          ...(e.color ? { color: themeColor(e.color, palette, palette.text) } : {}),
          ...(e.align ? { alignment: e.align as Alignment } : {}),
          ...(e.letter_spacing ? { characterSpacing: e.letter_spacing } : {}),
          ...(e.line_height ? { lineHeight: e.line_height } : {}),
          margin: room(e.after),
        },
      ];
    }
    case "logo":
      if (!input.logo) return [];
      return [{ image: input.logo, fit: [e.width ?? 160, e.height ?? 40], alignment: e.align ?? "left", margin: room(e.after) }];
    case "rule": {
      const thickness = e.thickness ?? 1;
      return [
        {
          table: { widths: ["*"], body: [[{ text: "", fontSize: 0.1, lineHeight: 0.1 }]] },
          layout: {
            hLineWidth: (i: number) => (i === 1 ? thickness : 0),
            vLineWidth: () => 0,
            hLineColor: () => themeColor(e.color, palette, palette.border),
            paddingLeft: () => 0,
            paddingRight: () => 0,
            paddingTop: () => 0,
            paddingBottom: () => 0,
          },
          margin: room(e.after, 8),
        },
      ];
    }
    case "space":
      return [gap(e.height)];
    case "fields": {
      const rows = e.rows.map((r) => ({ label: fill(r.label, input), value: fill(r.value, input) })).filter((r) => e.hide_empty === false || r.value.trim());
      if (!rows.length) return [];
      const size = e.size ?? input.fontSize;
      const labelColor = themeColor(e.label_color, palette, palette.muted);
      const plain = e.style === "plain";
      const body: TableCell[][] = rows.map((r) => [
        {
          text: e.label_caps ? caps(r.label, input) : r.label,
          bold: !plain,
          color: labelColor,
          fontSize: e.label_caps ? size - 1 : size,
          ...(plain ? {} : { fillColor: themeColor(e.label_fill, palette, palette.fill) }),
        },
        { text: r.value || " ", fontSize: size, ...(e.value_bold ? { bold: true } : {}) },
      ]);
      const pad = e.padding ?? (plain ? 2 : 4.5);
      return [
        {
          table: { widths: [e.label_width ?? 120, "*"], body, dontBreakRows: true },
          layout: plain
            ? { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: (i) => (i === 0 ? 0 : 8), paddingRight: () => 0, paddingTop: () => pad, paddingBottom: () => pad }
            : {
                hLineWidth: () => 0.6,
                vLineWidth: (i, node) => (i === 0 || i === node.table.widths?.length ? 0.6 : 0),
                hLineColor: () => palette.border,
                vLineColor: () => palette.border,
                paddingLeft: () => 9,
                paddingRight: () => 9,
                paddingTop: () => pad,
                paddingBottom: () => pad,
              },
          margin: room(e.after, 8),
        },
      ];
    }
    case "list": {
      const items = e.items.map((item) => fill(item, input)).filter((item) => item.trim());
      if (!items.length) return [];
      const style = {
        fontSize: e.size ?? input.fontSize,
        ...(e.color ? { color: themeColor(e.color, palette, palette.text) } : {}),
        markerColor: palette.accent,
        margin: room(e.after, 6),
      };
      return [e.numbered ? { ol: items.map((text) => ({ text, margin: [0, 0, 0, 3] })), ...style } : { ul: items.map((text) => ({ text, margin: [0, 0, 0, 3] })), ...style }];
    }
    case "signature": {
      const lines = e.lines.map((l) => fill(l, input)).filter((l) => l.trim());
      const width = e.width ?? 170;
      const rule = themeColor(e.rule_color, palette, palette.accent);
      const signed: TableCell = {
        stack: lines.map((text, i) => ({ text, ...(i === 0 ? { bold: true } : { color: palette.muted, fontSize: input.fontSize - 1 }) })),
        border: [false, true, false, false],
        borderColor: [rule, rule, rule, rule],
      };
      const empty: TableCell = { text: "", border: [false, false, false, false] };
      // A table, not columns: its "*" cells take the room left beside the signature in any column.
      const side = e.align ?? "right";
      const row = side === "left" ? [signed, empty] : side === "center" ? [empty, signed, empty] : [empty, signed];
      const widths = row.map((c) => (c === signed ? width : "*"));
      return [
        {
          table: { widths, body: [row] },
          layout: { hLineWidth: () => 1.5, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 6, paddingBottom: () => 0 },
          margin: room(e.after, 8),
        },
      ];
    }
    case "blanks": {
      const per = Math.min(e.columns ?? 2, e.labels.length);
      const labels = e.labels.map((l) => fill(l, input));
      const rows: TableCell[][] = [];
      for (let i = 0; i < labels.length; i += per) {
        const row: TableCell[] = labels.slice(i, i + per).map((label) => ({
          stack: [{ text: label, fontSize: input.fontSize - 1.5, color: palette.muted, bold: true }, gap(e.height ?? 34)],
        }));
        while (row.length < per) row.push({ text: "" });
        rows.push(row);
      }
      return [
        {
          table: { widths: Array(per).fill("*"), body: rows, dontBreakRows: true },
          layout: {
            hLineWidth: () => 0.6,
            vLineWidth: () => 0.6,
            hLineColor: () => palette.border,
            vLineColor: () => palette.border,
            paddingLeft: () => 8,
            paddingRight: () => 8,
            paddingTop: () => 6,
            paddingBottom: () => 6,
          },
          margin: room(e.after, 8),
        },
      ];
    }
    case "box": {
      const stack = elements(e.items, input);
      if (!stack.length) return [];
      const box = cell(stack, {
        fillColor: e.fill ? themeColor(e.fill, palette, palette.fill) : undefined,
        border: e.border ? themeColor(e.border, palette, palette.border) : undefined,
        borderWidth: e.border_width ?? 0.8,
        padding: e.padding ?? 10,
      });
      return [{ ...box, margin: room(e.after, 8) }];
    }
    case "columns":
      return [
        {
          columns: e.columns.map((c) => ({ width: c.width ?? "*", stack: elements(c.items, input) })),
          columnGap: e.gap ?? 16,
          margin: room(e.after, 8),
        } as Content,
      ];
  }
}

/** Elements as content, top to bottom; the last element's room after it dropped, so boxes and columns end at their text. */
export function elements(list: ThemeElement[], input: ThemeLayoutInput): Content[] {
  return list.flatMap((e) => element(e, input));
}

/** The theme's page content: its elements with the body where it stands (at the end when it doesn't stand anywhere). */
export function themeContent(theme: PdfTheme, input: ThemeLayoutInput): Content[] {
  const list = theme.content ?? [];
  const placed = JSON.stringify(list).includes('"type":"body"');
  return elements(placed ? list : [...list, { type: "body" }], input);
}
