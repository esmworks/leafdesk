import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // These check code for the React Compiler, which this app doesn't use: reading a ref while
      // rendering, setting state in an effect, assigning to an editor's properties and calling
      // Date.now() while rendering are all fine without it.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
      // Images here are user content (avatars, covers, app logos) from any origin, or data URLs;
      // next/image needs every origin listed up front.
      "@next/next/no-img-element": "off",
      // Full page loads after signing in or out are on purpose: nothing of the old session stays
      // in client caches.
      "@next/next/no-location-assign-relative-destination": "off",
      // `_` marks what a destructuring leaves out on purpose.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Tests and end-to-end scripts read loosely typed JSON answers.
    files: ["scripts/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", ".claude/**", "next-env.d.ts", "drizzle/**", "desktop/**"]),
  // Runs inside an older release's checkout against that release's code (scripts/upgrade-test.sh).
  globalIgnores(["scripts/upgrade/**"]),
]);
