import { describe, expect, it } from "vitest";
import { applyBlockEdits } from "./block-edits";
import {
  buttonLine,
  buttonPlainText,
  buttonScope,
  cleanButtonLabel,
  mapButtonLines,
  MAX_BUTTON_LABEL,
  MAX_BUTTON_STEPS,
  parseButtonConfig,
  parseButtonLine,
  restoreButtons,
  buttonColor,
  serializeButtonConfig,
} from "./buttons";

describe("button settings", () => {
  it("keep known steps and fields only", () => {
    const config = parseButtonConfig(
      JSON.stringify({
        confirm: true,
        steps: [
          { type: "insert", at: "nowhere", markdown: "Hi", extra: 1 },
          { type: "run_code", code: "x" },
          { type: "add_row", databaseId: "db1", title: "{{today}}", values: { p1: "a", p2: { $: "actor" }, p3: { nested: true }, p4: ["x", 2] } },
          { type: "notify", userIds: ["u1", "u1", 3, "u2"], message: "Look" },
          { type: "update_rows", databaseId: "db1", filters: [{ propertyId: "p1", operator: "is", value: "a" }], filterCombinator: "xor", values: {} },
          "nonsense",
        ],
      }),
    );
    expect(config.confirm).toBe(true);
    expect(config.steps).toEqual([
      { type: "insert", at: "below", markdown: "Hi" },
      { type: "add_row", databaseId: "db1", title: "{{today}}", values: { p1: "a", p2: { $: "actor" }, p4: ["x"] } },
      { type: "notify", userIds: ["u1", "u2"], message: "Look" },
      { type: "update_rows", databaseId: "db1", filters: [{ propertyId: "p1", operator: "is", value: "a" }], filterCombinator: "and", values: {} },
    ]);
  });

  it("read nothing from what isn't settings, and hold at most so many steps", () => {
    expect(parseButtonConfig("not json")).toEqual({ confirm: false, steps: [] });
    expect(parseButtonConfig("")).toEqual({ confirm: false, steps: [] });
    expect(parseButtonConfig([1, 2])).toEqual({ confirm: false, steps: [] });
    const many = { confirm: false, steps: Array.from({ length: 20 }, () => ({ type: "webhook", url: "https://example.com" })) };
    expect(parseButtonConfig(serializeButtonConfig(many as never)).steps).toHaveLength(MAX_BUTTON_STEPS);
  });

  it("keep an add-row step's row template: an id, the database's default one, or none", () => {
    const steps = (template: unknown) =>
      parseButtonConfig({ confirm: false, steps: [{ type: "add_row", databaseId: "db1", title: "", values: {}, template }] }).steps;
    expect(steps("tpl-1")).toEqual([{ type: "add_row", databaseId: "db1", title: "", values: {}, template: "tpl-1" }]);
    expect(steps("default")).toEqual([{ type: "add_row", databaseId: "db1", title: "", values: {}, template: "default" }]);
    for (const bad of [undefined, "", 42, "../x", "x".repeat(101), { id: "tpl-1" }]) {
      expect(steps(bad)).toEqual([{ type: "add_row", databaseId: "db1", title: "", values: {} }]);
    }
  });

  it("keep a label to one short line", () => {
    expect(cleanButtonLabel("  Start\n the   week ")).toBe("Start the week");
    expect(cleanButtonLabel(42)).toBe("");
    expect(cleanButtonLabel("x".repeat(500))).toHaveLength(MAX_BUTTON_LABEL);
  });
});

describe("buttonScope", () => {
  it("gives the day and moment in the clicker's time zone, and who they are", () => {
    const scope = buttonScope(new Date("2026-03-01T23:30:00Z"), "Europe/Istanbul", { id: "u1", name: "Ada", email: "ada@example.com" });
    expect(scope.today).toBe("2026-03-02");
    expect(scope.now).toBe("2026-03-02 02:30");
    expect(scope.me).toEqual({ id: "u1", name: "Ada", email: "ada@example.com", type: "person" });
  });
});

describe("button Markdown lines", () => {
  it("round-trip the id and label, quotes and comment ends too", () => {
    const label = 'Say "hi" --> now';
    const line = buttonLine("b-1", label);
    expect(line).not.toContain("-->\"");
    expect(line.indexOf("-->")).toBe(line.length - 3);
    expect(parseButtonLine(line)).toEqual({ id: "b-1", label });
    expect(parseButtonLine(buttonLine("b-2", ""))).toEqual({ id: "b-2", label: "" });
    expect(parseButtonLine("<!-- leafdesk:button -->")).toBeNull();
    expect(parseButtonLine("text <!-- leafdesk:button b1 -->")).toBeNull();
  });

  it("put the page's button back, at any depth, with a new label", () => {
    type Block = { id?: string; type: string; props?: Record<string, unknown>; children?: Block[] };
    const existing: Block[] = [
      { id: "p", type: "paragraph", children: [{ id: "b1", type: "button", props: { label: "Old", icon: "🚀", config: "{}" }, children: [] }] },
    ];
    const parsed: Block[] = [
      { id: "b1", type: "button", props: { label: "New" }, children: [] },
      { type: "columnList", children: [{ id: "b1", type: "button", props: { label: "Again" }, children: [] }] },
      { id: "b9", type: "button", props: { label: "Made up" }, children: [] },
    ];
    expect(restoreButtons(parsed, existing)).toEqual([
      { id: "b1", type: "button", props: { label: "New", icon: "🚀", config: "{}" }, children: [] },
      { type: "columnList", children: [] },
    ]);
    // Without a label in the line the button keeps its own.
    expect(restoreButtons<Block>([{ id: "b1", type: "button", props: { label: "" }, children: [] }], existing)[0].props).toEqual({ label: "Old", icon: "🚀", config: "{}" });
  });

  it("become a line of their own in exports, outside code only", () => {
    const markdown = ["Intro", buttonLine("b1", "Go"), "```", buttonLine("b2", "Code"), "```"].join("\n");
    expect(mapButtonLines(markdown, ({ label }) => `*Button ${label}*`).split("\n")).toEqual(["Intro", "*Button Go*", "```", buttonLine("b2", "Code"), "```"]);
  });

  it("take a color of the option palette only", () => {
    expect(buttonColor("green")).toBe("green");
    expect(buttonColor("")).toBeNull();
    expect(buttonColor("Green")).toBeNull();
    expect(buttonColor("url(x)")).toBeNull();
    expect(buttonColor(undefined)).toBeNull();
  });

  it("read as their icon and label", () => {
    expect(buttonPlainText({ label: "Go", icon: "🚀" })).toBe("🚀 Go");
    expect(buttonPlainText({ label: "Go", icon: "" })).toBe("Go");
    expect(buttonPlainText(undefined)).toBe("");
  });
});

describe("prepend edits", () => {
  it("put blocks at the top of the body", () => {
    const body = [{ id: "a", type: "paragraph", props: {}, content: [], children: [] }];
    const added = [{ type: "heading", props: {}, content: [], children: [] }];
    const result = applyBlockEdits(body, [{ op: "prepend", blocks: added }]);
    expect("blocks" in result && result.blocks.map((b) => b.type)).toEqual(["heading", "paragraph"]);
  });
});
