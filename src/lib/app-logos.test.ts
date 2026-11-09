import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_LOGO_IDS, appLogo } from "./app-logos";

describe("appLogo", () => {
  it("knows apps by the name they registered with", () => {
    expect(appLogo("Claude")).toBe("/apps/claude.png");
    expect(appLogo("Claude Code")).toBe("/apps/claude.png");
    expect(appLogo("ChatGPT")).toBe("/apps/chatgpt.png");
    expect(appLogo("OpenAI Codex")).toBe("/apps/chatgpt.png");
    expect(appLogo("Visual Studio Code")).toBe("/apps/vscode.png");
    expect(appLogo("Le Chat")).toBe("/apps/mistral.png");
  });

  it("has none for other apps or parts of words", () => {
    expect(appLogo("My sync tool")).toBeNull();
    expect(appLogo("Cursorless")).toBeNull();
    expect(appLogo(null)).toBeNull();
  });

  it("has a file for every logo and no file left over", () => {
    const files = readdirSync(join(process.cwd(), "public/apps"))
      .filter((file) => file.endsWith(".png"))
      .map((file) => file.slice(0, -4))
      .sort();
    expect(files).toEqual([...APP_LOGO_IDS].sort());
  });
});
