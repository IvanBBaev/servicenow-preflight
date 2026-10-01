import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/build/", "**/node_modules/", "**/coverage/"] },
  js.configs.recommended,
  // Type-checked rules need a TS program; scope them to package sources so
  // plain-JS config and test files stay on the syntax-only ruleset.
  {
    files: ["packages/*/src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A forgotten await in an async pipeline stage silently drops errors.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [...tseslint.configs.recommended],
  },
  {
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
