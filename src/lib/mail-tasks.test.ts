import { describe, expect, it } from "vitest";
import { MAX_MAIL_TASKS, mailTaskDay, readMailTasks } from "./mail-tasks";

describe("readMailTasks", () => {
  it("reads the tasks of the model's answer, around fences and words", () => {
    const answer = 'İşte:\n```json\n{"tasks": [{"text": "  Fiyatı\\n gönder ", "date": "2026-10-30"}, {"text": "Sözleşmeyi oku", "date": null}]}\n```';
    expect(readMailTasks(answer)).toEqual([
      { text: "Fiyatı gönder", date: "2026-10-30" },
      { text: "Sözleşmeyi oku", date: null },
    ]);
  });

  it("drops empty tasks and days that aren't real, and keeps at most the limit", () => {
    const tasks = Array.from({ length: 14 }, (_, i) => ({ text: `iş ${i}`, date: i === 0 ? "2026-02-30" : "yarın" }));
    const read = readMailTasks(JSON.stringify({ tasks: [{ text: " " }, ...tasks] }));
    expect(read).toHaveLength(MAX_MAIL_TASKS);
    expect(read?.[0]).toEqual({ text: "iş 0", date: null });
  });

  it("reads an answer that isn't the list as none found", () => {
    expect(readMailTasks("Görev yok.")).toBeNull();
    expect(readMailTasks('{"items": []}')).toBeNull();
    expect(readMailTasks('{"tasks": []}')).toEqual([]);
  });

  it("checks days", () => {
    expect(mailTaskDay("2028-02-29")).toBe("2028-02-29");
    expect(mailTaskDay("2026-13-01")).toBeNull();
    expect(mailTaskDay(20261001)).toBeNull();
  });
});
