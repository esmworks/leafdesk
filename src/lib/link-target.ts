/**
 * What the link field (components/page/link-page-button.tsx) makes of what was typed: an address
 * to link to, or null when it reads as words to search pages by. Addresses with a scheme or a path
 * in the app are kept as they are; a bare host (`example.com/docs`) gets https.
 */
export function linkTarget(input: string): string | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(text)) return text;
  if (text.startsWith("/") && !text.startsWith("//")) return text;
  // A host: labels with a dot between them and a top-level part of letters, a path after it.
  if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(:\d+)?([/?#].*)?$/u.test(text)) return `https://${text}`;
  return null;
}
