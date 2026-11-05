/**
 * Reading skills people bring from elsewhere (server/skill-import.ts): a SKILL.md file, or a ZIP of
 * skill folders as AI assistants keep them (`<name>/SKILL.md` beside the files it refers to:
 * scripts, references, templates). Pure: what the upload holds is found here, written there.
 *
 * The text comes from an untrusted upload, so it is read by hand, line by line: no regex runs over
 * more than one line of it.
 */
import { MAX_SKILL_DESCRIPTION } from "./skills";

/** An upload of skills: at most this many bytes, this many skills, and files beside each. */
export const SKILL_IMPORT_LIMITS = {
  uploadBytes: 20 * 1024 * 1024,
  skills: 20,
  filesPerSkill: 20,
  /** A SKILL.md longer than this is refused: no skill needs it, and the chat uses at most 20,000. */
  skillChars: 200_000,
} as const;

export type ParsedSkill = { name: string | null; description: string; title: string; body: string };

/** A YAML scalar as front matter writes one: "double quoted" (JSON's escapes), 'single quoted' or plain. */
function scalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/** Whether a line belongs to the value above it: indented, or empty inside a block. */
const indented = (line: string) => line.startsWith(" ") || line.startsWith("\t");

/**
 * The keys of a front matter's top level, each as text: plain and quoted values, values that go on
 * on indented lines, and `|` / `>` blocks (literal keeps the lines, folded joins them). Nested maps
 * (a skill's `metadata`) come back as their raw lines, which nothing here reads.
 */
export function frontMatter(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || indented(line) || line.trimStart().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1).trim();
    const more: string[] = [];
    while (i + 1 < lines.length && (indented(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim());
    while (more.length && !more.at(-1)) more.pop();
    if (rest === "|" || rest === "|-" || rest === "|+") out.set(key, more.join("\n"));
    else if (rest === ">" || rest === ">-" || rest === ">+") out.set(key, more.join(" ").replace(/ {2,}/g, " ").trim());
    else out.set(key, scalar([rest, ...more].filter(Boolean).join(" ")));
  }
  return out;
}

/** A skill's name made readable as a title: "release-notes" → "Release notes". */
export function titleFromName(name: string): string {
  const words = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words ? words[0].toLocaleUpperCase("en") + words.slice(1) : "";
}

/**
 * A SKILL.md (or any Markdown file brought as a skill): its front matter's name and description,
 * and its body. The title is the body's first heading when it starts with one (taken out of the
 * body), else the name made readable, else `fallback` (the file's or folder's name).
 */
export function parseSkillMarkdown(text: string, fallback: string): ParsedSkill {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  let meta = new Map<string, string>();
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
    if (end > 0) {
      meta = frontMatter(lines.slice(1, end));
      start = end + 1;
    }
  }
  const body = lines.slice(start);
  while (body.length && !body[0].trim()) body.shift();
  let heading: string | null = null;
  if (body[0]?.startsWith("# ")) {
    heading = body.shift()!.slice(2).trim();
    while (body.length && !body[0].trim()) body.shift();
  }
  const name = meta.get("name")?.trim() || null;
  const description = (meta.get("description") ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SKILL_DESCRIPTION);
  return { name, description, title: heading || titleFromName(name ?? "") || titleFromName(fallback) || fallback, body: body.join("\n").trimEnd() };
}

export type FoundSkill = {
  /** The SKILL.md's (or Markdown file's) path in the upload. */
  path: string;
  /** Its folder's or file's name, for a title when the file names none. */
  fallback: string;
  /** The other files of its folder (and the folders under it, but not another skill's), by path. */
  files: string[];
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const isSkillFile = (path: string) => baseName(path).toLowerCase() === "skill.md";
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(baseName(path));

/**
 * The skills an upload holds, by path: every SKILL.md, with the files of its folder (a folder of
 * its own, never the upload's top level, whose other files may be anything). An upload without a
 * SKILL.md brings each of its top-level Markdown files as a skill of its own, without files.
 */
export function findSkills(paths: string[]): FoundSkill[] {
  const skills = paths.filter(isSkillFile).sort((a, b) => a.localeCompare(b));
  if (!skills.length) {
    return paths
      .filter((p) => isMarkdown(p) && !p.includes("/"))
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({ path, fallback: baseName(path).replace(/\.(md|markdown)$/i, ""), files: [] }));
  }
  const folders = skills.map(folderOf);
  return skills.map((path, i) => {
    const folder = folders[i];
    const inside = (p: string) => folder !== "" && p.startsWith(`${folder}/`);
    // A file belongs to the deepest skill folder it is in.
    const owner = (p: string) => folders.reduce((best, f) => (f !== "" && p.startsWith(`${f}/`) && f.length > best.length ? f : best), "");
    return {
      path,
      fallback: folder ? baseName(folder) : "skill",
      files: folder ? paths.filter((p) => p !== path && inside(p) && owner(p) === folder).sort((a, b) => a.localeCompare(b)) : [],
    };
  });
}
