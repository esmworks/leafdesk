import { describe, expect, it } from "vitest";
import type { PropertyOptions, PropertyType } from "@/db/schema/app";
import {
  checkAnswers,
  conditionHolds,
  defaultFormConfig,
  formConfigError,
  formDefaults,
  formQuestions,
  formSchemaError,
  hiddenQuestions,
  isAskable,
  isPublicAskable,
  MAX_FORM_QUESTIONS,
  MAX_TEXT_ANSWER,
  MAX_TITLE_ANSWER,
} from "./forms";
import { layoutConfigError } from "./views";

const prop = (id: string, type: PropertyType, options: PropertyOptions = {}) => ({ id, name: id[0].toUpperCase() + id.slice(1), type, options });

const status = prop("status", "status", {
  options: [
    { id: "new", name: "New", color: "gray", group: "todo" },
    { id: "done", name: "Done", color: "green", group: "done" },
  ],
});
const tags = prop("tags", "multi_select", { options: [{ id: "a", name: "A", color: "red" }] });
const props = [
  prop("notes", "text"),
  prop("count", "number"),
  prop("email", "email"),
  prop("site", "url"),
  prop("agree", "checkbox"),
  prop("due", "date"),
  status,
  tags,
  prop("owner", "person"),
  prop("link", "relation", { relation: { databaseId: "other" } }),
  prop("author", "created_by"),
  prop("items", "checklist"),
];

describe("askable properties", () => {
  it("leaves out values Leafdesk fills in, and relations and people from public forms", () => {
    expect(isAskable("text")).toBe(true);
    expect(isAskable("created_by")).toBe(false);
    expect(isAskable("last_edited_time")).toBe(false);
    expect(isAskable("person")).toBe(true);
    expect(isPublicAskable("person")).toBe(false);
    expect(isPublicAskable("relation")).toBe(false);
    expect(isPublicAskable("status")).toBe(true);
  });

  it("starts a new form with the name and every askable property", () => {
    const config = defaultFormConfig(props);
    expect(config.questions?.[0]).toEqual({ propertyId: "title", required: true });
    expect(config.questions?.map((q) => q.propertyId)).not.toContain("author");
    expect(config.questions).toHaveLength(props.length); // title in, created_by out
  });
});

describe("formQuestions", () => {
  const form = {
    questions: [
      { propertyId: "title", required: true, label: "  Your name " },
      { propertyId: "gone" },
      { propertyId: "author" },
      { propertyId: "owner" },
      { propertyId: "email", description: "We reply here" },
      { propertyId: "email", required: true },
    ],
  };

  it("skips deleted, read-only and repeated questions", () => {
    const qs = formQuestions(form, props);
    expect(qs.map((q) => q.propertyId)).toEqual(["title", "owner", "email"]);
    expect(qs[0]).toMatchObject({ prop: null, required: true, label: "Your name" });
    expect(qs[2]).toMatchObject({ required: false, description: "We reply here" });
  });

  it("drops relation and person questions from public forms", () => {
    expect(formQuestions(form, props, { public: true }).map((q) => q.propertyId)).toEqual(["title", "email"]);
  });
});

describe("formDefaults", () => {
  it("keeps defaults for existing, writable properties the form doesn't ask", () => {
    const form = {
      questions: [{ propertyId: "email" }],
      defaults: { status: "new", email: "x@example.com", author: ["u1"], gone: 1, count: null },
    };
    expect(formDefaults(form, props)).toEqual({ status: "new" });
  });
});

describe("formConfigError", () => {
  it("accepts a well-formed form and no form at all", () => {
    expect(formConfigError(undefined)).toBeNull();
    expect(
      formConfigError({
        title: "Feedback",
        description: "Tell us",
        questions: [{ propertyId: "title", required: true, label: "Name", description: "Full name" }],
        defaults: { status: "new" },
        confirmation: "Thanks!",
        allowAnother: false,
      }),
    ).toBeNull();
  });

  it.each([
    ["not an object", "form"],
    [{ questions: "title" }, "list"],
    [{ questions: [{}] }, "property id"],
    [{ questions: [{ propertyId: "a" }, { propertyId: "a" }] }, "once"],
    [{ questions: [{ propertyId: "a", required: "yes" }] }, "required"],
    [{ questions: [{ propertyId: "a", label: 3 }] }, "label"],
    [{ questions: [{ propertyId: "a", description: "x".repeat(1001) }] }, "description"],
    [{ questions: Array.from({ length: MAX_FORM_QUESTIONS + 1 }, (_, i) => ({ propertyId: `p${i}` })) }, "at most"],
    [{ title: "x".repeat(201) }, "title"],
    [{ allowAnother: "no" }, "allowAnother"],
    [{ defaults: [] }, "defaults"],
    [{ defaults: { title: "x" } }, "name"],
  ])("refuses %j", (form, message) => {
    expect(formConfigError(form)).toContain(message);
  });

  it("is part of the view config check", () => {
    expect(layoutConfigError({ form: { questions: [{ propertyId: 1 }] } } as never)).toContain("property id");
  });
});

describe("checkAnswers", () => {
  const questions = formQuestions(
    {
      questions: [
        { propertyId: "title", required: true, label: "Name" },
        { propertyId: "notes" },
        { propertyId: "count" },
        { propertyId: "email", required: true },
        { propertyId: "agree", required: true },
        { propertyId: "status" },
        { propertyId: "tags" },
        { propertyId: "due" },
        { propertyId: "items" },
      ],
    },
    props,
  );

  it("turns answers into a row, trimming text and resolving option names", () => {
    const result = checkAnswers(questions, {
      title: "  Ada  ",
      notes: " line one\nline two ",
      count: "4,5",
      email: " ada@example.com ",
      agree: true,
      status: "Done",
      tags: ["a"],
      due: "2026-10-01",
      items: ["one", " ", "two"],
      ignored: "not a question",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe("Ada");
    expect(result.properties).toMatchObject({
      notes: "line one\nline two",
      count: 4.5,
      email: "ada@example.com",
      agree: true,
      status: "done",
      tags: ["a"],
      due: "2026-10-01",
    });
    expect((result.properties.items as { text: string }[]).map((i) => i.text)).toEqual(["one", "two"]);
    expect(result.properties).not.toHaveProperty("ignored");
  });

  it("leaves unanswered optional questions out", () => {
    const result = checkAnswers(questions, { title: "Ada", email: "a@b.co", agree: true, notes: "   ", tags: [] });
    expect(result).toEqual({ ok: true, title: "Ada", properties: { email: "a@b.co", agree: true } });
  });

  it("reports every missing required answer and every bad value, named by the question", () => {
    const result = checkAnswers(questions, { title: " ", email: "nope", agree: false, count: "many", status: "Unknown" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { propertyId: "title", code: "required", params: { property: "Name" } },
      { propertyId: "count", code: "invalidNumber", params: { property: "Count" } },
      { propertyId: "email", code: "invalidEmail", params: { property: "Email" } },
      { propertyId: "agree", code: "required", params: { property: "Agree" } },
      { propertyId: "status", code: "unknownOption", params: { property: "Status", value: "Unknown" } },
    ]);
  });

  it("refuses answers that are too long or too many", () => {
    const result = checkAnswers(questions, {
      title: "x".repeat(MAX_TITLE_ANSWER + 1),
      notes: "x".repeat(MAX_TEXT_ANSWER + 1),
      tags: Array.from({ length: 101 }, () => "a"),
      email: "a@b.co",
      agree: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => [e.propertyId, e.code])).toEqual([
      ["title", "tooLong"],
      ["notes", "tooLong"],
      ["tags", "tooMany"],
    ]);
  });

  it("refuses a name that isn't text", () => {
    const result = checkAnswers(questions.slice(0, 1), { title: ["x"] });
    expect(result.ok).toBe(false);
  });
});

describe("conditions", () => {
  const form = {
    questions: [
      { propertyId: "title" },
      { propertyId: "status" },
      { propertyId: "notes", required: true, showIf: { propertyId: "status", op: "is" as const, values: ["done", "gone"] } },
      { propertyId: "agree" },
      { propertyId: "email", required: true, showIf: { propertyId: "agree", op: "checked" as const } },
      { propertyId: "site", showIf: { propertyId: "notes", op: "contains" as const, values: ["Web"] } },
      { propertyId: "tags", showIf: { propertyId: "items", op: "notEmpty" as const } },
      { propertyId: "items" },
    ],
  };
  const questions = formQuestions(form, props);

  it("keeps conditions that still hold, without options that are gone, and drops the others", () => {
    const by = Object.fromEntries(questions.map((q) => [q.propertyId, q.showIf]));
    expect(by.notes).toEqual({ propertyId: "status", op: "is", values: ["done"] });
    expect(by.email).toEqual({ propertyId: "agree", op: "checked" });
    // About a later question: asked always.
    expect(by.tags).toBeUndefined();
    // About a question taken out of the form, or of a type that can't be checked that way.
    const stale = formQuestions(
      {
        questions: [
          { propertyId: "agree" },
          { propertyId: "notes", showIf: { propertyId: "gone", op: "notEmpty" } },
          { propertyId: "site", showIf: { propertyId: "agree", op: "is", values: ["x"] } },
          { propertyId: "count", showIf: { propertyId: "status", op: "is", values: ["done"] } },
        ],
      },
      props,
    );
    expect(stale.map((q) => q.showIf)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("checks answers as the form holds them and as they are stored", () => {
    expect(conditionHolds({ op: "is", values: ["done"] }, "status", "done")).toBe(true);
    expect(conditionHolds({ op: "isNot", values: ["done"] }, "status", undefined)).toBe(true);
    expect(conditionHolds({ op: "contains", values: ["a"] }, "multi_select", ["b", "a"])).toBe(true);
    expect(conditionHolds({ op: "notContains", values: ["a"] }, "multi_select", ["b"])).toBe(true);
    expect(conditionHolds({ op: "contains", values: ["web"] }, "text", " My WEBsite ")).toBe(true);
    expect(conditionHolds({ op: "unchecked" }, "checkbox", undefined)).toBe(true);
    expect(conditionHolds({ op: "empty" }, "text", "   ")).toBe(true);
    expect(conditionHolds({ op: "notEmpty" }, "files", [])).toBe(false);
  });

  it("hides questions whose condition isn't met, and those depending on a hidden one", () => {
    expect([...hiddenQuestions(questions, {})].sort()).toEqual(["email", "notes", "site"]);
    expect([...hiddenQuestions(questions, { status: "done", notes: "web shop" })].sort()).toEqual(["email"]);
    // The text matches, but the question it is about isn't asked: neither is this one.
    expect(hiddenQuestions(questions, { status: "new", notes: "web shop" }).has("site")).toBe(true);
  });

  it("drops answers to questions not asked and requires the others", () => {
    const hidden = checkAnswers(questions, { title: "A", status: "new", notes: "kept?", site: "https://x.test", agree: false, email: "nope" });
    expect(hidden).toEqual({ ok: true, title: "A", properties: { status: "new" } });
    const shown = checkAnswers(questions, { title: "A", status: "Done", agree: true });
    expect(shown.ok).toBe(false);
    if (shown.ok) return;
    // "Done" is an option name: worked out as the option before the condition looks at it.
    expect(shown.errors.map((e) => [e.propertyId, e.code])).toEqual([
      ["notes", "required"],
      ["email", "required"],
    ]);
  });
});

describe("choice limits", () => {
  const many = prop("many", "multi_select", {
    options: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), color: "gray" })),
  });
  const questions = formQuestions(
    {
      questions: [
        { propertyId: "many", minChoices: 2, maxChoices: 2 },
        { propertyId: "owner", maxChoices: 1 },
        { propertyId: "notes", minChoices: 1 },
      ],
    },
    [...props, many],
  );

  it("apply to list questions only", () => {
    expect(questions.map((q) => [q.minChoices, q.maxChoices])).toEqual([
      [2, 2],
      [undefined, 1],
      [undefined, undefined],
    ]);
  });

  it("refuse too few and too many choices, but not an optional question left empty", () => {
    const result = checkAnswers(questions, { many: ["a"], owner: ["u1", "u2"] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { propertyId: "many", code: "tooFew", params: { min: "2", property: "Many" } },
      { propertyId: "owner", code: "tooMany", params: { max: "1", property: "Owner" } },
    ]);
    expect(checkAnswers(questions, { many: ["a", "b"], owner: ["u1"] }).ok).toBe(true);
    expect(checkAnswers(questions, {}).ok).toBe(true);
  });
});

describe("form settings for conditions and limits", () => {
  it.each([
    [{ questions: [{ propertyId: "a", showIf: { propertyId: "b", op: "empty" } }, { propertyId: "b" }] }, "earlier"],
    [{ questions: [{ propertyId: "a", showIf: { propertyId: "a", op: "empty" } }] }, "earlier"],
    [{ questions: [{ propertyId: "a" }, { propertyId: "b", showIf: { propertyId: "a", op: "near" } }] }, "check"],
    [{ questions: [{ propertyId: "a" }, { propertyId: "b", showIf: { propertyId: "a", op: "is", values: [] } }] }, "values"],
    [{ questions: [{ propertyId: "a" }, { propertyId: "b", showIf: { propertyId: "a", op: "empty", values: ["x"] } }] }, "no values"],
    [{ questions: [{ propertyId: "a", minChoices: 0 }] }, "minChoices"],
    [{ questions: [{ propertyId: "a", minChoices: 3, maxChoices: 2 }] }, "more than"],
    [{ showOwnAnswers: "yes" }, "showOwnAnswers"],
  ])("refuses %j", (form, message) => {
    expect(formConfigError(form)).toContain(message);
  });

  it("accepts a condition about an earlier question", () => {
    expect(
      formConfigError({
        questions: [{ propertyId: "a" }, { propertyId: "b", showIf: { propertyId: "a", op: "is", values: ["x"] }, maxChoices: 3 }],
        showOwnAnswers: true,
      }),
    ).toBeNull();
  });

  it("checks them against the properties when they change", () => {
    const form = (showIf: object, extra: object = {}) =>
      ({ questions: [{ propertyId: "status" }, { propertyId: "tags", showIf, ...extra }] }) as never;
    expect(formSchemaError(form({ propertyId: "status", op: "is", values: ["done"] }, { maxChoices: 1 }), props)).toBeNull();
    expect(formSchemaError(form({ propertyId: "status", op: "is", values: ["nope"] }), props)).toContain("option");
    expect(formSchemaError(form({ propertyId: "status", op: "checked" }), props)).toContain("can't check");
    expect(formSchemaError(form({ propertyId: "author", op: "empty" }), props)).toContain("can't ask");
    expect(formSchemaError({ questions: [{ propertyId: "notes", maxChoices: 2 }] }, props)).toContain("number of choices");
    // Unchanged from what is stored: what later changes broke is left for the form to ignore.
    const stale = form({ propertyId: "status", op: "is", values: ["nope"] });
    expect(formSchemaError(stale, props, stale)).toBeNull();
  });
});
