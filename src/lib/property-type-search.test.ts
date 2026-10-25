import { describe, expect, it } from "vitest";
import { newPropertyName, typesMatching } from "./property-type-search";

const TYPES = ["text", "number", "select", "multi_select", "status", "date", "person", "checkbox"] as const;
const EN: Record<(typeof TYPES)[number], string> = {
  text: "Text",
  number: "Number",
  select: "Select",
  multi_select: "Multi-select",
  status: "Status",
  date: "Date",
  person: "Person",
  checkbox: "Checkbox",
};
const TR: Record<(typeof TYPES)[number], string> = {
  text: "Metin",
  number: "Sayı",
  select: "Seçim",
  multi_select: "Çoklu seçim",
  status: "Durum",
  date: "Tarih",
  person: "Kişi",
  checkbox: "Onay kutusu",
};
const en = (type: (typeof TYPES)[number]) => EN[type];
const tr = (type: (typeof TYPES)[number]) => TR[type];

describe("typesMatching", () => {
  it("finds types by their name in the person's language, those starting with the text first", () => {
    expect(typesMatching(TYPES, en, "sel")).toEqual(["select", "multi_select"]);
    expect(typesMatching(TYPES, en, "  STAT ")).toEqual(["status"]);
    expect(typesMatching(TYPES, tr, "seç")).toEqual(["select", "multi_select"]);
    // The dotted and dotless i are alike, whatever the keyboard typed.
    expect(typesMatching(TYPES, tr, "KIŞI")).toEqual(["person"]);
    expect(typesMatching(TYPES, en, "box")).toEqual(["checkbox"]);
  });

  it("finds none for an empty text or a name that is no type's", () => {
    expect(typesMatching(TYPES, en, "")).toEqual([]);
    expect(typesMatching(TYPES, en, "Priority")).toEqual([]);
    expect(typesMatching(TYPES, en, "Due date")).toEqual([]);
  });
});

describe("newPropertyName", () => {
  it("names the property after its type when the text is just the type's name", () => {
    expect(newPropertyName("status", en, "status")).toBe("Status");
    expect(newPropertyName("date", tr, " tarih ")).toBe("Tarih");
    expect(newPropertyName("date", en, "")).toBe("Date");
  });

  it("keeps any other text as the name", () => {
    expect(newPropertyName("date", en, "Due")).toBe("Due");
    expect(newPropertyName("number", en, "Date")).toBe("Date");
  });
});
