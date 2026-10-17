import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { direction, fill, pickLocale, STRINGS } from "./strings.ts";

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("the same languages as the web app", () => {
  const config = fs.readFileSync(new URL("../../src/i18n/config.ts", import.meta.url), "utf8");
  const web = [...config.matchAll(/^\s+(\w{2}): "/gm)].map((match) => match[1]);
  assert.deepEqual(Object.keys(STRINGS).sort(), [...web].sort());
});

test("every language has every text, with the same placeholders", () => {
  const english = STRINGS.en;
  for (const [locale, strings] of Object.entries(STRINGS)) {
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      assert.ok(strings[key]?.trim(), `${locale}.${key} is empty`);
      assert.deepEqual(placeholders(strings[key]), placeholders(english[key]), `${locale}.${key} placeholders`);
    }
  }
});

test("picking a language", () => {
  assert.equal(pickLocale(["tr-TR", "en-US"]), "tr");
  assert.equal(pickLocale(["pt-BR"]), "pt");
  assert.equal(pickLocale(["zh-Hans-CN"]), "zh");
  assert.equal(pickLocale(["nl-NL", "de-AT"]), "de");
  assert.equal(pickLocale(["nl-NL"]), "en");
  assert.equal(pickLocale([]), "en");
});

test("direction and placeholders", () => {
  assert.equal(direction("ar"), "rtl");
  assert.equal(direction("he"), "rtl");
  assert.equal(direction("fa"), "rtl");
  assert.equal(direction("tr"), "ltr");
  assert.equal(fill("Can’t reach {host}", { host: "a.example" }), "Can’t reach a.example");
  assert.equal(fill("{missing}", {}), "{missing}");
});
