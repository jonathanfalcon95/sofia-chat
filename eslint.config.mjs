import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Only repositories talk to the database, so the backend can change behind them.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/db/**", "src/lib/supabase/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='from'][arguments.0.type='Literal'][callee.object.name!='Buffer'][callee.object.name!='Array']",
          message: "Mueve esta consulta a un repositorio en src/lib/db/repos.",
        },
        {
          selector: "CallExpression[callee.property.name='rpc']",
          message: "Mueve esta llamada a un repositorio en src/lib/db/repos.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
