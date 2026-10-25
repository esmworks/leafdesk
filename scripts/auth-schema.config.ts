// Used only by `pnpm auth:schema` to generate src/db/schema/auth.ts; the secret is never used at runtime.
import { betterAuth } from "better-auth";
import { baseAuthOptions } from "../src/lib/auth-options";

export const auth = betterAuth({ ...baseAuthOptions(), secret: "schema-generation-only-not-used-at-runtime-0000" });
