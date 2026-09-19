import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rule that the two real providers share one lifecycle is only a rule if a
 * test walks the modules (slice 7.3 acceptance: no provider triplet of
 * duplicated delegator methods). `computer-runtime.ts` composes the eight
 * `ComputerProvider` operations once; each provider ships only the primitives
 * its own wire can answer, and neither may re-implement `ensure`, `status`,
 * `snapshot`, `restore` or `destroy` — the seam methods that would drift if
 * two providers each wrote their own idempotency, readiness or key rules.
 *
 * The scan is structural: a provider module that grows `async ensure(` has
 * copied the lifecycle, whatever it names it.
 */

const sourceDir = fileURLToPath(new URL(".", import.meta.url));
const runtimeModule = path.join(sourceDir, "computer-runtime.ts");
const providerModules = [
  path.join(sourceDir, "docker-computer.ts"),
  path.join(sourceDir, "daytona-computer.ts"),
];
/** The seam methods the shared lifecycle owns; a provider must not define them. */
const sharedMethods = ["ensure", "status", "snapshot", "restore", "destroy"];

describe("the shared computer lifecycle call sites", () => {
  it("builds both real providers through the shared runtime", () => {
    for (const module of providerModules) {
      const source = readFileSync(module, "utf8");

      expect(source, `${path.basename(module)} does not use the shared lifecycle`).toContain(
        "createRuntimeComputerProvider",
      );
    }

    const runtime = readFileSync(runtimeModule, "utf8");

    for (const method of sharedMethods) {
      expect(runtime, `the shared lifecycle does not implement ${method}`).toContain(
        `async ${method}(`,
      );
    }
  });

  it("leaves the seam composition to the shared runtime", () => {
    for (const module of providerModules) {
      const source = readFileSync(module, "utf8");

      for (const method of sharedMethods) {
        expect(
          new RegExp(`async ${method}\\(`).test(source),
          `${path.basename(module)} implements ${method} itself`,
        ).toBe(false);
      }
    }
  });

  it("proves the scan fails on a copied lifecycle", () => {
    const copied = "return { async ensure(computer) { return computer; } };";

    expect(new RegExp("async ensure\\(").test(copied)).toBe(true);
  });
});
