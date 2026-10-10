import { describe, expect, it } from "vitest";
import { checkFormula, parseFormula, rewriteReferences, runFormula, type Field, type FormulaType, type Value } from ".";
import { formatDate, toDateValue } from "./dates";

const NOW = new Date("2026-09-27T10:30:00Z");

type Fields = Record<string, { type: FormulaType; value: Value }>;

/** Checks and evaluates `expression` with `fields` as properties; returns the stored value or the error code. */
function run(expression: string, fields: Fields = {}, now = NOW) {
  const parsed = parseFormula(expression);
  const resolve = (key: string): Field | undefined => (fields[key] ? { name: key, type: fields[key].type } : undefined);
  const { type, error } = checkFormula(parsed, resolve);
  if (error) return { error: error.code, message: error.message, type };
  try {
    const { stored } = runFormula(parsed.ast, { value: (key) => fields[key].value, now });
    return { value: stored, type };
  } catch (e) {
    return { error: (e as { error: { code: string } }).error.code, type };
  }
}

const value = (expression: string, fields?: Fields) => run(expression, fields).value;
const error = (expression: string, fields?: Fields) => run(expression, fields).error;

describe("parsing and precedence", () => {
  it("follows arithmetic precedence", () => {
    expect(value("1 + 2 * 3")).toBe(7);
    expect(value("(1 + 2) * 3")).toBe(9);
    expect(value("10 - 4 - 3")).toBe(3);
    expect(value("2 ^ 3 ^ 2")).toBe(512);
    expect(value("-2 ^ 2")).toBe(-4);
    expect(value("7 % 4")).toBe(3);
    expect(value("1 + 2 > 2 and 3 < 4")).toBe(true);
    expect(value("not 1 > 2")).toBe(true);
    expect(value("true or false and false")).toBe(true);
    expect(value("!(true && false) || false")).toBe(true);
  });

  it("reads literals", () => {
    expect(value('"a \\"quoted\\" word"')).toBe('a "quoted" word');
    expect(value("'single'")).toBe("single");
    expect(value("“smart”")).toBe("smart");
    expect(value(".5 + 1.5e1")).toBe(15.5);
    expect(value("TRUE")).toBe(true);
  });

  it("treats an empty formula as empty text", () => {
    expect(run("   ")).toEqual({ value: null, type: "text" });
  });

  it("reports syntax errors with positions", () => {
    expect(error("1 +")).toBe("unexpectedEnd");
    expect(error("1 + * 2")).toBe("syntax");
    expect(error('"open')).toBe("unterminatedString");
    expect(error("1 2")).toBe("syntax");
    expect(error("abs 1")).toBe("syntax");
    expect(error("1 # 2")).toBe("syntax");
    expect(error("prop(1)")).toBe("propArgument");
    const parsed = parseFormula("1 + $");
    expect(parsed.error).toMatchObject({ code: "syntax", start: 4, end: 5 });
  });

  it("bounds length and nesting", () => {
    expect(error("1+".repeat(2100) + "1")).toBe("tooLong");
    expect(error("(".repeat(80) + "1" + ")".repeat(80))).toBe("tooDeep");
  });
});

describe("type checking", () => {
  it("decides the result type", () => {
    expect(run("1 + 1").type).toBe("number");
    expect(run('"a" + 1').type).toBe("text");
    expect(run("1 > 0").type).toBe("checkbox");
    expect(run("now()").type).toBe("date");
    expect(run('prop("Tags")', { Tags: { type: "list", value: ["a", "b"] } })).toEqual({ value: "a, b", type: "text" });
  });

  it("rejects mismatched operands and arguments", () => {
    expect(error("1 - true")).toBe("operatorType");
    expect(error('1 == "1"')).toBe("operatorType");
    expect(error("true < false")).toBe("operatorType");
    expect(error("-true")).toBe("unaryType");
    expect(error('not "x"')).toBe("unaryType");
    expect(error('abs("x")')).toBe("argumentType");
    expect(error("abs()")).toBe("argumentCount");
    expect(error("abs(1, 2)")).toBe("argumentCount");
    expect(error('if(1, 2, 3)')).toBe("argumentType");
    expect(error('if(true, 1, "x")')).toBe("branchTypes");
    expect(error("ifs(true, 1, false, 2)")).toBe("ifsArguments");
    expect(error("nope(1)")).toBe("unknownFunction");
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(error(`${name}(1)`), name).toBe("unknownFunction");
    }
    expect(error('prop("Missing")')).toBe("unknownProperty");
    expect(error('dateAdd(now(), 1, "fortnights")')).toBe("invalidUnit");
    expect(error('prop("Tags") + "x"', { Tags: { type: "list", value: [] } })).toBe("operatorType");
  });

  it("names the function and types in messages", () => {
    expect(run('round("x")').message).toBe("round() expects number as argument 1, not text");
    expect(run('length(1)').message).toBe("length() expects text or list as argument 1, not number");
  });

  it("matches function names without regard to case", () => {
    expect(value("ROUND(2.5)")).toBe(3);
    expect(value("dateadd(today(), 1, \"day\") > today()")).toBe(true);
  });
});

describe("evaluation", () => {
  const fields: Fields = {
    Price: { type: "number", value: 12.5 },
    Qty: { type: "number", value: 4 },
    Empty: { type: "number", value: null },
    Name: { type: "text", value: "Widget" },
    Blank: { type: "text", value: "" },
    Done: { type: "checkbox", value: true },
    Due: { type: "date", value: { date: Date.UTC(2026, 9, 1), time: false } },
    NoDate: { type: "date", value: null },
    Tags: { type: "list", value: ["red", "blue"] },
  };

  it("does arithmetic with property values", () => {
    expect(value('prop("Price") * prop("Qty")', fields)).toBe(50);
    expect(value("0.1 + 0.2")).toBeCloseTo(0.3);
    expect(value('prop("Price") + prop("Empty")', fields)).toBe(12.5);
    expect(value('prop("Empty") * prop("Empty")', fields)).toBeNull();
    // An empty divisor is a row not filled in yet, not a division by zero.
    expect(value('10 / prop("Empty")', fields)).toBeNull();
    expect(value('10 % prop("Empty")', fields)).toBeNull();
    expect(value('prop("Empty") / 4', fields)).toBe(0);
    expect(value('prop("Empty") > 1', fields)).toBe(false);
    expect(value('prop("Empty") == prop("Empty")', fields)).toBe(true);
  });

  it("reports per-row runtime errors", () => {
    expect(error("1 / 0")).toBe("divisionByZero");
    expect(error('prop("Price") % (prop("Qty") - 4)', fields)).toBe("divisionByZero");
    expect(error('toNumber("abc")')).toBe("notANumber");
    expect(error('parseDate("tomorrow")')).toBe("invalidDate");
    expect(error("sqrt(-1)")).toBe("notFinite");
    expect(error('dateAdd(now(), 1, "x" + "y")')).toBe("invalidUnit");
  });

  it("evaluates if lazily", () => {
    expect(value("if(false, 1 / 0, 2)")).toBe(2);
    expect(value("ifs(false, 1, true, 2, 3)")).toBe(2);
    expect(value("ifs(false, 1, false, 2, 3)")).toBe(3);
    expect(value("false and 1 / 0 > 1")).toBe(false);
    expect(value("or(true, 1 / 0 > 1)")).toBe(true);
  });

  it("has text functions", () => {
    expect(value('concat(prop("Name"), " x", 2, true)', fields)).toBe("Widget x2true");
    expect(value('"Total: " + prop("Price")', fields)).toBe("Total: 12.5");
    expect(value('length(prop("Name"))', fields)).toBe(6);
    expect(value('length(prop("Tags"))', fields)).toBe(2);
    expect(value('upper(prop("Name")) + lower("AB")', fields)).toBe("WIDGETab");
    expect(value('contains(prop("Tags"), "red")', fields)).toBe(true);
    expect(value('contains(prop("Name"), "dge")', fields)).toBe(true);
    expect(value('replace("a-b-c", "-", "+")')).toBe("a+b-c");
    expect(value('replaceAll("a-b-c", "-", "+")')).toBe("a+b+c");
    expect(value('slice("formula", 1, 4)')).toBe("orm");
    expect(value('slice("formula", -2)')).toBe("la");
    expect(value('join(prop("Tags"), " / ")', fields)).toBe("red / blue");
    expect(value('format(1 / 3)')).toBe("0.333333333333");
    expect(value('trim("  x ") + "|"')).toBe("x|");
    expect(value('startsWith("abc", "ab") and endsWith("abc", "bc")')).toBe(true);
    expect(value('prop("Blank")', fields)).toBeNull();
  });

  it("has number functions", () => {
    expect(value("round(1.005, 2)")).toBe(1.01);
    expect(value("round(-2.5)")).toBe(-2);
    expect(value("floor(1.9) + ceil(1.1) + abs(-3)")).toBe(6);
    expect(value("min(3, 1, 2) + max(3, 1, 2)")).toBe(4);
    expect(value('min(prop("Empty"), 5)', fields)).toBe(5);
    expect(value("pow(2, 10) + sqrt(16)")).toBe(1028);
    expect(value('toNumber("1,5") + toNumber(true)')).toBe(2.5);
  });

  it("counts missing values, blank text and zero as empty", () => {
    expect(value('empty(prop("Empty"))', fields)).toBe(true);
    expect(value('empty(prop("Blank"))', fields)).toBe(true);
    expect(value("empty(0)")).toBe(true);
    expect(value('empty(prop("Tags"))', fields)).toBe(false);
    expect(value('not empty(prop("Done"))', fields)).toBe(true);
  });

  it("works with dates at a fixed now", () => {
    expect(value("now()")).toBe("2026-09-27T10:30:00.000Z");
    expect(value("today()")).toMatch(/^2026-09-2[67]$/);
    expect(value('dateAdd(prop("Due"), 1, "month")', fields)).toBe("2026-11-01");
    expect(value('dateSubtract(prop("Due"), 2, "weeks")', fields)).toBe("2026-09-17");
    expect(value('dateAdd(parseDate("2026-01-31"), 1, "months")')).toBe("2026-02-28");
    expect(value('dateAdd(prop("Due"), 3, "hours")', fields)).toBe("2026-10-01T03:00:00.000Z");
    expect(value('dateBetween(prop("Due"), parseDate("2026-09-27"), "days")', fields)).toBe(4);
    expect(value('dateBetween(parseDate("2026-01-01"), parseDate("2026-03-31"), "months")')).toBe(-2);
    expect(value('dateBetween(parseDate("2027-03-01"), parseDate("2026-03-02"), "years")')).toBe(0);
    expect(value('formatDate(prop("Due"), "dddd, MMMM D YYYY [at] HH:mm")', fields)).toBe("Thursday, October 1 2026 at 00:00");
    expect(value('year(prop("Due")) * 100 + month(prop("Due")) + day(prop("Due"))', fields)).toBe(202611);
    expect(value('weekday(prop("Due"))', fields)).toBe(4);
    expect(value('prop("Due") > now()', fields)).toBe(true);
    expect(value('dateAdd(prop("NoDate"), 1, "day")', fields)).toBeNull();
    expect(value('formatDate(prop("NoDate"))', fields)).toBeNull();
    expect(value('year(prop("NoDate"))', fields)).toBeNull();
    expect(value('timestamp(parseDate("1970-01-02"))')).toBe(86_400_000);
  });

  it("reads ranges by their start, with dateStart and dateEnd", () => {
    const ranged: Fields = { Trip: { type: "date", value: toDateValue("2026-10-12/2026-10-14") } };
    expect(value('prop("Trip")', ranged)).toBe("2026-10-12/2026-10-14");
    expect(value('dateStart(prop("Trip"))', ranged)).toBe("2026-10-12");
    expect(value('dateEnd(prop("Trip"))', ranged)).toBe("2026-10-14");
    expect(value('dateBetween(dateEnd(prop("Trip")), dateStart(prop("Trip")), "days")', ranged)).toBe(2);
    expect(value('dateAdd(prop("Trip"), 1, "day")', ranged)).toBe("2026-10-13");
    expect(value('format(prop("Trip"))', ranged)).toBe("2026-10-12 → 2026-10-14");
    expect(value('dateEnd(parseDate("2026-10-12"))')).toBe("2026-10-12");
    const timed: Fields = { Call: { type: "date", value: toDateValue("2026-10-12T09:00:00.000Z/2026-10-12T10:30:00.000Z") } };
    expect(value('dateBetween(dateEnd(prop("Call")), prop("Call"), "minutes")', timed)).toBe(90);
    expect(value('hour(prop("Call"))', timed)).toBe(9);
  });

  it("formats timestamps in UTC", () => {
    expect(formatDate({ date: Date.UTC(2026, 0, 5, 15, 4), time: true }, "hh:mm A")).toBe("03:04 PM");
    expect(formatDate({ date: Date.UTC(2026, 0, 5), time: false })).toBe("2026-01-05");
  });

  it("caps text length", () => {
    const fieldsWithLong: Fields = { Long: { type: "text", value: "x".repeat(6000) } };
    expect(error('prop("Long") + prop("Long")', fieldsWithLong)).toBe("resultTooLong");
  });
});

describe("rewriteReferences", () => {
  it("rewrites prop keys and keeps everything else", () => {
    const text = 'prop("Price") * 2 + length( "prop(\\"Price\\")" ) + prop( \'Qty\' )';
    const out = rewriteReferences(text, (key) => ({ Price: "p1", Qty: "q1" })[key] ?? null);
    expect(out).toBe('prop("p1") * 2 + length( "prop(\\"Price\\")" ) + prop( "q1" )');
  });

  it("escapes names with quotes", () => {
    expect(rewriteReferences('prop("x")', () => 'Say "hi"')).toBe('prop("Say \\"hi\\"")');
  });

  it("stops rewriting at text it can't read", () => {
    expect(rewriteReferences('prop("a") + prop("b', (key) => key.toUpperCase())).toBe('prop("A") + prop("b');
  });
});
