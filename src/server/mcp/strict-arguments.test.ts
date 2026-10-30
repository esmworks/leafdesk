import { describe, expect, it } from "vitest";
import * as z from "zod";
import { refusingUnknownArguments } from "./strict-arguments";

const schema = z.object({ database_id: z.string(), limit: z.number().default(50) });

describe("refusingUnknownArguments", () => {
  it("passes the arguments the tool takes, with its defaults", async () => {
    expect(await refusingUnknownArguments(schema)["~standard"].validate({ database_id: "db-1" })).toEqual({
      value: { database_id: "db-1", limit: 50 },
    });
  });

  it("refuses others, naming the ones it takes", async () => {
    const one = await refusingUnknownArguments(schema)["~standard"].validate({ database_id: "db-1", filter: "x" });
    expect(one.issues?.map((i) => i.message)).toEqual(['Unknown argument "filter". This tool takes: database_id, limit']);
    const two = await refusingUnknownArguments(z.object({}))["~standard"].validate({ a: 1, b: 2 });
    expect(two.issues?.map((i) => i.message)).toEqual(['Unknown arguments "a", "b". This tool takes: no arguments']);
  });

  it("keeps the schema as the tool list shows it", () => {
    expect(refusingUnknownArguments(schema)["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toEqual(
      schema["~standard"].jsonSchema.input({ target: "draft-2020-12" }),
    );
  });
});
