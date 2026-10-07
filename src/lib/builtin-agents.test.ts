import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import { loadLocaleFile, withFallback } from "@/i18n/messages";
import en from "@/i18n/messages/en/agentTemplates.json";
import { MAX_AGENT_INSTRUCTIONS, MAX_AGENT_PROMPT } from "./agents";
import {
  BUILTIN_AGENT_KEYS,
  buildBuiltinAgent,
  builtinAgentGallery,
  fill,
  MAX_ROUTER_PROPERTIES,
  MAX_ROUTER_RULES,
  newPropertyNames,
  type BuiltinAgentNames,
  type BuiltinAgentTexts,
} from "./builtin-agents";

const textsOf = async (locale: (typeof LOCALES)[number]): Promise<BuiltinAgentTexts> =>
  locale === "en" ? en : withFallback(en, await loadLocaleFile(locale, "agentTemplates"));

const examples: BuiltinAgentNames[] = [
  {
    key: "ticket-router",
    database: "Support tickets",
    properties: [
      { name: "Team", type: "select", options: ["Billing", "Tech"] },
      { name: "Assignee", type: "person", options: [] },
    ],
    rules: "Money questions go to Billing and {database} stays as typed.",
  },
  { key: "request-answerer", database: "Requests", property: "Answer", answered: "Done", needsPerson: "Escalate", pages: ["Refund policy", ""] },
  { key: "duplicate-finder", database: "Bugs", property: "Duplicate?" },
];

describe("fill", () => {
  it("fills placeholders in one pass and keeps unknown ones", () => {
    expect(fill("{a} and {b} and {c}", { a: "{b}", b: "B" })).toBe("{b} and B and {c}");
  });
});

describe("built-in agents", () => {
  it.each(LOCALES)("%s: names every property, option and page it uses, with nothing left to fill in", async (locale) => {
    const texts = await textsOf(locale);
    const quote = (value: string) => fill(texts.quoted, { value });
    expect(builtinAgentGallery(texts).map((t) => t.key)).toEqual([...BUILTIN_AGENT_KEYS]);
    for (const names of examples) {
      const agent = buildBuiltinAgent(texts, names);
      expect(agent.name.trim(), `${locale} ${names.key}`).not.toBe("");
      expect(agent.description.trim()).not.toBe("");
      expect(agent.task.length).toBeLessThanOrEqual(MAX_AGENT_PROMPT);
      expect(agent.automation("Bot")).toContain("Bot");
      // Only the rules the owner wrote may still have braces.
      const withoutRules = names.key === "ticket-router" ? agent.instructions.replace(names.rules, "") : agent.instructions;
      expect(withoutRules, `${locale} ${names.key}`).not.toMatch(/\{\w+\}/);
      expect(agent.instructions).toContain(quote(names.database));
      if (names.key === "ticket-router") {
        expect(agent.instructions).toContain(names.rules);
        for (const p of names.properties) expect(agent.instructions).toContain(quote(p.name));
        expect(agent.instructions).toContain(`${quote("Billing")}, ${quote("Tech")}`);
      } else if (names.key === "request-answerer") {
        for (const value of [names.property, names.answered, names.needsPerson, "Refund policy", texts.untitled]) {
          expect(agent.instructions).toContain(quote(value));
        }
      } else {
        expect(agent.instructions).toContain(quote(names.property));
      }
    }
  });

  it.each(LOCALES)("%s: a new property's options are distinct", async (locale) => {
    const texts = await textsOf(locale);
    for (const key of BUILTIN_AGENT_KEYS) {
      const own = newPropertyNames(texts, key);
      expect(own.name.trim()).not.toBe("");
      expect(new Set(own.options).size).toBe(own.options.length);
    }
    expect(newPropertyNames(texts, "request-answerer").options).toHaveLength(2);
  });

  it("fits the longest setup within an agent's instructions", () => {
    const longest = buildBuiltinAgent(en, {
      key: "ticket-router",
      database: "x".repeat(200),
      properties: Array.from({ length: MAX_ROUTER_PROPERTIES }, (_, i) => ({
        name: `Property ${i}`,
        type: "select" as const,
        options: Array.from({ length: 20 }, (_, j) => `Option ${j}`),
      })),
      rules: "r".repeat(MAX_ROUTER_RULES),
    });
    expect(longest.instructions.length).toBeLessThanOrEqual(MAX_AGENT_INSTRUCTIONS);
  });

  it("uses the database's own name, or Untitled", () => {
    const agent = buildBuiltinAgent(en, { key: "duplicate-finder", database: "  ", property: "Dup" });
    expect(agent.instructions).toContain("“Untitled”");
  });
});
