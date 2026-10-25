/** The text sizes a page can be exported to PDF in, in percent of the usual size (the PDF dialog's menu). */
export const PDF_TEXT_SCALES = [75, 90, 100, 110, 125, 150] as const;

/** An export's `?scale=` as a factor of the usual size: one of PDF_TEXT_SCALES, else 1. */
export function pdfTextScale(value: unknown): number {
  const percent = Number(value);
  return (PDF_TEXT_SCALES as readonly number[]).includes(percent) ? percent / 100 : 1;
}
