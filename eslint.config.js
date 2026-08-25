// ESLint flat config for the mentro monorepo.
// Division of labor: ESLint owns code quality, Prettier owns formatting
// (see .prettierrc in the same directory) — do not add formatting rules here.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/protocol/gen/**",
      "bin/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
