import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        { allowExpressions: true },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-constant-condition": "off",
      eqeqeq: ["error", "always"],
    },
  },
  {
    ignores: ["dist/**", "node_modules/**", "eslint.config.js"],
  },
);
