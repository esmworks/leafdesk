import { describe, expect, it } from "vitest";
import { isTicked, PAGE_TASK_TEXT_MAX, pageTasksIn } from "./page-tasks";

const text = (value: string) => ({ type: "text", text: value, styles: {} });
const person = (userId: string, name = userId) => ({ type: "mention", props: { kind: "user", userId, name, id: `m-${userId}` } });
const group = (groupId: string) => ({ type: "mention", props: { kind: "group", groupId, name: "Design" } });
const date = (value: string) => ({ type: "mention", props: { kind: "date", date: value } });
const pageMention = (pageId: string) => ({ type: "mention", props: { kind: "page", pageId } });
const todo = (id: string, content: unknown[], { checked = false, children = [] as unknown[] } = {}) => ({
  id,
  type: "checkListItem",
  props: { checked },
  content,
  children,
});

describe("pageTasksIn", () => {
  it("lists an unticked to-do for the person it mentions, its text without the mention", () => {
    expect(pageTasksIn([todo("b1", [person("ada"), text(": send the invoice")])])).toEqual([
      { blockId: "b1", userId: "ada", text: "send the invoice", date: null },
    ]);
  });

  it("leaves out ticked to-dos, to-dos without a person and other blocks that mention someone", () => {
    expect(
      pageTasksIn([
        todo("ticked", [text("Done "), person("ada")], { checked: true }),
        todo("nobody", [text("Buy milk")]),
        todo("group", [group("g1"), text(" review the copy")]),
        { id: "para", type: "paragraph", props: {}, content: [person("ada"), text(" said hello")], children: [] },
        { id: "bullet", type: "bulletListItem", props: {}, content: [text("Ask "), person("ada")], children: [] },
      ]),
    ).toEqual([]);
  });

  it("gives each person mentioned their entry, once however often they are named", () => {
    const tasks = pageTasksIn([todo("b1", [person("ada"), text(" and "), person("bo"), text(" plan the launch with "), person("ada")])]);
    expect(tasks.map((t) => [t.userId, t.text])).toEqual([
      ["ada", "and plan the launch with"],
      ["bo", "and plan the launch with"],
    ]);
  });

  it("finds nested to-dos on their own, under ticked ones and inside other blocks", () => {
    const tasks = pageTasksIn([
      todo("parent", [text("Launch "), person("ada")], {
        children: [todo("child", [text("Write the post "), person("bo")])],
      }),
      todo("doneParent", [text("Old")], { checked: true, children: [todo("stillOpen", [text("Follow up "), person("ada")])] }),
      {
        id: "toggle",
        type: "toggleListItem",
        props: {},
        content: [text("More")],
        children: [todo("inToggle", [text("Call "), person("cy")])],
      },
    ]);
    expect(tasks.map((t) => [t.blockId, t.userId, t.text])).toEqual([
      ["parent", "ada", "Launch"],
      ["child", "bo", "Write the post"],
      ["stillOpen", "ada", "Follow up"],
      ["inToggle", "cy", "Call"],
    ]);
  });

  it("keeps the first date mentioned, a day or a time, and drops dates and page mentions from the text", () => {
    const [day] = pageTasksIn([todo("b1", [text("Ship "), pageMention("p1"), text(" by "), date("2026-10-12"), text(" or "), date("2026-10-20"), person("ada")])]);
    expect(day).toEqual({ blockId: "b1", userId: "ada", text: "Ship by or", date: "2026-10-12" });
    const [time] = pageTasksIn([todo("b2", [person("ada"), text(" call at "), date("2026-10-12T09:30:00.000Z")])]);
    expect(time.date).toBe("2026-10-12T09:30:00.000Z");
    const [none] = pageTasksIn([todo("b3", [person("ada"), text(" whenever "), date("soon")])]);
    expect(none.date).toBeNull();
  });

  it("reads mentions and text inside links, and a link mention by its title", () => {
    const [task] = pageTasksIn([
      todo("b1", [
        { type: "link", href: "https://example.com", content: [text("Read the brief")] },
        text(" from "),
        { type: "mention", props: { kind: "link", url: "https://example.com/doc", title: "Spec" } },
        { type: "link", href: "https://example.com", content: [person("ada")] },
      ]),
    ]);
    expect(task).toEqual({ blockId: "b1", userId: "ada", text: "Read the brief from Spec", date: null });
  });

  it("keeps the text short and counts a block copied with its id once", () => {
    const long = "word ".repeat(200);
    const tasks = pageTasksIn([todo("b1", [person("ada"), text(long)]), todo("b1", [person("ada"), text("copy")])]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].text.length).toBe(PAGE_TASK_TEXT_MAX);
    expect(tasks[0].text.endsWith("…")).toBe(true);
  });

  it("gives a to-do of only a mention empty text, and skips one without an id", () => {
    expect(pageTasksIn([todo("b1", [person("ada")])])).toEqual([{ blockId: "b1", userId: "ada", text: "", date: null }]);
    expect(pageTasksIn([{ type: "checkListItem", props: {}, content: [person("ada")], children: [] }])).toEqual([]);
  });
});

describe("isTicked", () => {
  it("reads BlockNote's boolean and a stored string", () => {
    expect(isTicked({ checked: true })).toBe(true);
    expect(isTicked({ checked: "true" })).toBe(true);
    expect(isTicked({ checked: false })).toBe(false);
    expect(isTicked({})).toBe(false);
    expect(isTicked(undefined)).toBe(false);
  });
});
