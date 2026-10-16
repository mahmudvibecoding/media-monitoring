import pluginQuery from "@tanstack/eslint-plugin-query";
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...pluginQuery.configs["flat/recommended"],
  prettier, // Prettier lays the code out, so no ESLint rules about layout
  // src/api/ is the typed client "pnpm api" writes
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "src/api/**"]),
]);

export default eslintConfig;
