/**
 * Logos of well-known AI apps that connect over MCP, so what they keep (memory notes) shows the
 * app's own mark. Each is a 96 px PNG in `public/apps`, taken from the app's own site (its largest
 * favicon). The app is told by the name it registered with; an unknown one has no logo.
 */
const APP_LOGOS: { id: string; match: RegExp }[] = [
  { id: "claude", match: /\b(claude|anthropic)\b/i },
  { id: "chatgpt", match: /\b(chatgpt|openai|codex)\b/i },
  { id: "gemini", match: /\bgemini\b/i },
  { id: "cursor", match: /\bcursor\b/i },
  { id: "perplexity", match: /\bperplexity\b/i },
  { id: "mistral", match: /\b(mistral|le chat)\b/i },
  { id: "grok", match: /\b(grok|xai)\b/i },
  { id: "raycast", match: /\braycast\b/i },
  { id: "vscode", match: /\b(visual studio code|vs ?code|copilot)\b/i },
  { id: "windsurf", match: /\b(windsurf|codeium)\b/i },
];

/** The ids of the logos in `public/apps` (tests check they match the files). */
export const APP_LOGO_IDS = APP_LOGOS.map((logo) => logo.id);

/** The logo's path for an app's name, or null when it isn't a known one. */
export function appLogo(name: string | null | undefined): string | null {
  if (!name) return null;
  const found = APP_LOGOS.find((logo) => logo.match.test(name));
  return found ? `/apps/${found.id}.png` : null;
}
