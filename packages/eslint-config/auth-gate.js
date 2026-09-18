/**
 * The auth gate rule from AGENTS.md: in `@porkbot/api`, procedures are
 * registered through the gated implementers in `src/gate.ts`, and `implement`
 * is called nowhere else.
 *
 * A router that calls `implement(appContract)` itself registers procedures on
 * the un-authenticated path — the discipline-only failure PRD decision 7
 * exists to remove — so the rule fails lint instead of relying on review to
 * notice. `test/boundaries.test.mjs` proves the rule fires on
 * `fixtures/api-raw-implement.ts` and stays silent on a gated router.
 */

export function authGateConfigsFor(packageName) {
  if (packageName !== "@porkbot/api") {
    return [];
  }

  return [
    {
      name: "porkbot/auth-gate/@porkbot/api",
      files: ["**/*.ts", "**/*.tsx"],
      // The gate itself is the one file that may call `implement(...)`.
      ignores: ["**/src/gate.ts", "src/gate.ts"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.name='implement']",
            message:
              "Register procedures through the auth gate in apps/api/src/gate.ts " +
              "(`authenticated` or `publicOnly`); calling `implement` here bypasses " +
              "the authenticated default (PRD decision 7).",
          },
        ],
      },
    },
  ];
}
