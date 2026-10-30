import type * as z from "zod";

type Standard = z.ZodObject["~standard"];
type Result = Awaited<ReturnType<Standard["validate"]>>;

/**
 * A tool's input that refuses an argument the tool doesn't take, naming the ones it does: a
 * misspelt `filter` for `filters` is otherwise dropped, and the call runs without it (listing
 * every row). The tool list still shows `schema` as written, since `additionalProperties: false`
 * on every tool would cost each session's list about 2 KB.
 */
export function refusingUnknownArguments(schema: z.ZodObject): { "~standard": Standard } {
  const strict = schema.strict()["~standard"];
  const known = Object.keys(schema.shape).join(", ");
  const explain = (result: Result): Result => {
    if (!result.issues) return result;
    return {
      issues: result.issues.map((issue) => {
        const { code, keys } = issue as { code?: string; keys?: string[] };
        if (code !== "unrecognized_keys" || !keys?.length) return issue;
        const names = keys.map((k) => `"${k}"`).join(", ");
        return { ...issue, message: `${keys.length > 1 ? "Unknown arguments" : "Unknown argument"} ${names}. This tool takes: ${known || "no arguments"}` };
      }),
    };
  };
  return {
    "~standard": {
      ...schema["~standard"],
      validate: (value) => {
        const result = strict.validate(value);
        return result instanceof Promise ? result.then(explain) : explain(result);
      },
    },
  };
}
