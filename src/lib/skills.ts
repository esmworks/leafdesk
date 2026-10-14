/** Skills (server/skills.ts): names, descriptions and SKILL.md files, without the database. */

/** The longest description, as SKILL.md files allow. */
export const MAX_SKILL_DESCRIPTION = 1024;
/** A name for MCP clients and SKILL.md files: lowercase letters, digits and hyphens. */
export const MAX_SKILL_NAME = 64;
/** How much of the body stands in for a description that was left empty. */
const FALLBACK_DESCRIPTION = 200;

/**
 * The skill's name from its title: accents dropped (ı as i), lowercase letters and digits, words
 * joined by hyphens, at most MAX_SKILL_NAME characters; "skill" when nothing is left.
 */
export function skillSlug(title: string): string {
  const slug = title
    .replace(/ı/g, "i")
    .replace(/İ/g, "I")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SKILL_NAME)
    .replace(/-+$/, "");
  return slug || "skill";
}

/**
 * Names for a list of skills, unique among them: in the order given (the oldest first, so names
 * stay put as skills are added), a name already taken gets "-2", "-3" and so on.
 */
export function skillNames(skills: readonly { id: string; title: string }[]): Map<string, string> {
  const taken = new Set<string>();
  const names = new Map<string, string>();
  for (const skill of skills) {
    const base = skillSlug(skill.title);
    let name = base;
    for (let n = 2; taken.has(name); n++) {
      const suffix = `-${n}`;
      name = `${base.slice(0, MAX_SKILL_NAME - suffix.length).replace(/-+$/, "")}${suffix}`;
    }
    taken.add(name);
    names.set(skill.id, name);
  }
  return names;
}

/** The description to show: the one written, else the start of the body, on one line. */
export function describeSkill(description: string, bodyText: string): { description: string; described: boolean } {
  const written = description.trim();
  if (written) return { description: written, described: true };
  const text = bodyText.replace(/\s+/g, " ").trim();
  if (text.length <= FALLBACK_DESCRIPTION) return { description: text, described: false };
  const cut = text.slice(0, FALLBACK_DESCRIPTION - 1);
  const space = cut.lastIndexOf(" ");
  return { description: `${(space > FALLBACK_DESCRIPTION / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, described: false };
}

/** A SKILL.md file: YAML front matter with the name and description, then the instructions. */
export function skillMarkdown(skill: { name: string; description: string; body: string }): string {
  // Quoted as JSON strings, which YAML reads as double-quoted scalars.
  const description = JSON.stringify(skill.description.replace(/\s+/g, " ").trim());
  return `---\nname: ${skill.name}\ndescription: ${description}\n---\n\n${skill.body.trim()}\n`;
}
