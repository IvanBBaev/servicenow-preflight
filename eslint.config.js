import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // site/ is a standalone static docs site (browser JS, its own concerns) —
  // not part of the library/CLI source, so keep it off this Node/TS gate.
  { ignores: ["build/", "node_modules/", "coverage/", "site/"] },
  js.configs.recommended,
  // Type-checked rules need a TS program; scope them to src/ so plain-JS
  // config and test files stay on the syntax-only ruleset.
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A forgotten await in an async check handler silently drops errors.
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
  // The bin launcher is intentionally CommonJS with `var` so ancient Node can
  // parse it and print the version guard; keep it off the modern JS ruleset.
  { files: ["bin/**/*.cjs"], rules: { "no-var": "off" } },
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
);
