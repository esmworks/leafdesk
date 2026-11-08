import { describe, expect, it } from "vitest";
import { taskTitle } from "./message-task";

describe("taskTitle", () => {
  it("takes the first line with words", () => {
    expect(taskTitle("\n  Send the offer \nwith the price")).toBe("Send the offer");
  });

  it("cuts a long line at a word", () => {
    const title = taskTitle("word ".repeat(40), 30);
    expect(title.length).toBeLessThanOrEqual(30);
    expect(title.endsWith("word…")).toBe(true);
  });

  it("cuts inside a word that has no space to stop at", () => {
    expect(taskTitle("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
