import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROVIDER_FAILURE_KINDS } from "./failures.ts";
import type { FailureMapping, ProviderFailureKind } from "./failures.ts";
import { PROVIDER_INTERFACES, PROVIDER_SHAPES } from "./provider-plan.ts";

/**
 * The adapter-kit contract check (PRD module map; slice 5.1).
 *
 * This package declares interfaces and no implementations, so the rule "an
 * interface with one implementation is a hypothesis" cannot be proven from
 * shipped code alone. It is proven against `PROVIDER_INTERFACES`: every
 * interface declared here must be registered with at least two planned
 * implementations, each pinned to a roadmap slice, and every seam must carry a
 * mapping that documents all five failure kinds. The discovery reads this
 * package's own sources, so a new interface cannot be added without making the
 * choice the rule asks for: plan two implementations, or register it as a data
 * shape.
 *
 * The validator is exercised against deliberately broken plans as well, so a
 * check that stops firing (a renamed field, a skipped comparison) fails here
 * instead of silently passing.
 */

const sourceDir = fileURLToPath(new URL(".", import.meta.url));

interface DiscoveredInterface {
  readonly name: string;
  readonly module: string;
}

interface PlanImplementation {
  readonly name: string;
  readonly slice: string;
  readonly owner: string;
  readonly status: "shipped" | "planned";
}

interface PlanSeam {
  readonly interface: string;
  readonly module: string;
  readonly capability: string;
  readonly failures: FailureMapping;
  readonly implementations: readonly PlanImplementation[];
}

interface PlanShape {
  readonly module: string;
  readonly interfaces: readonly string[];
}

function sourceModules(): string[] {
  return readdirSync(sourceDir).filter(
    (filename) => filename.endsWith(".ts") && !filename.endsWith(".test.ts"),
  );
}

function discoverInterfaces(): DiscoveredInterface[] {
  const found: DiscoveredInterface[] = [];

  for (const filename of sourceModules()) {
    const source = readFileSync(path.join(sourceDir, filename), "utf8");

    for (const [, name = ""] of source.matchAll(/^export interface (\w+)/gm)) {
      found.push({ name, module: `./${filename}` });
    }
  }

  return found;
}

const importSpecifier = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/g;

function foreignImports(
  sources: readonly { readonly name: string; readonly source: string }[],
): string[] {
  const offenders: string[] = [];

  for (const { name, source } of sources) {
    for (const [, target = ""] of source.matchAll(importSpecifier)) {
      if (!target.startsWith("./") || !target.endsWith(".ts")) {
        offenders.push(`${name} imports ${target}`);
      }
    }
  }

  return offenders;
}

function validateProviderPlan(input: {
  readonly discovered: readonly DiscoveredInterface[];
  readonly seams: readonly PlanSeam[];
  readonly shapes: readonly PlanShape[];
}): string[] {
  const errors: string[] = [];
  const registered = new Map<string, string>();

  function register(name: string, module: string, kind: string): void {
    const previous = registered.get(name);

    if (previous !== undefined) {
      errors.push(`${name} is registered twice (${previous} and ${kind} in ${module})`);
      return;
    }

    registered.set(name, `${kind} in ${module}`);
  }

  for (const seam of input.seams) {
    register(seam.interface, seam.module, "a seam");

    if (seam.capability.trim() === "") {
      errors.push(`seam ${seam.interface} names no capability`);
    }

    if (seam.implementations.length < 2) {
      errors.push(
        `seam ${seam.interface} names ${seam.implementations.length} implementation(s); the rule requires at least two`,
      );
    }

    for (const implementation of seam.implementations) {
      if (implementation.name.trim() === "") {
        errors.push(`seam ${seam.interface} has an unnamed implementation`);
      }

      if (!/^\d+\.\d+$/.test(implementation.slice)) {
        errors.push(
          `implementation ${implementation.name} of ${seam.interface} names no roadmap slice, got ${JSON.stringify(implementation.slice)}`,
        );
      }

      if (implementation.owner.trim() === "") {
        errors.push(
          `implementation ${implementation.name} of ${seam.interface} names no owning package`,
        );
      }

      if (implementation.status !== "shipped" && implementation.status !== "planned") {
        errors.push(
          `implementation ${implementation.name} of ${seam.interface} has status ${JSON.stringify(implementation.status)}`,
        );
      }
    }

    for (const kind of PROVIDER_FAILURE_KINDS) {
      const text = seam.failures[kind];

      if (typeof text !== "string" || text.trim() === "") {
        errors.push(`seam ${seam.interface} does not document the ${kind} failure`);
      }
    }

    for (const kind of Object.keys(seam.failures)) {
      if (!(PROVIDER_FAILURE_KINDS as readonly string[]).includes(kind)) {
        errors.push(
          `seam ${seam.interface} documents an unknown failure kind ${JSON.stringify(kind)}`,
        );
      }
    }
  }

  for (const shape of input.shapes) {
    for (const name of shape.interfaces) {
      register(name, shape.module, "a shape");
    }
  }

  const discoveredName = new Map(input.discovered.map((entry) => [entry.name, entry.module]));

  for (const [name, registration] of registered) {
    const module = discoveredName.get(name);

    if (module === undefined) {
      errors.push(
        `${name} is registered as ${registration} but is not declared as an exported interface`,
      );
      continue;
    }

    if (!registration.endsWith(module)) {
      errors.push(`${name} is registered in ${registration} but declared in ${module}`);
    }
  }

  for (const { name, module } of input.discovered) {
    if (!registered.has(name)) {
      errors.push(
        `${name} in ${module} is unregistered: name at least two planned implementations in PROVIDER_INTERFACES, or list it in PROVIDER_SHAPES if it is data`,
      );
    }
  }

  return errors;
}

function completeMapping(
  overrides: Partial<Record<ProviderFailureKind, string | undefined>> = {},
): FailureMapping {
  const complete: Record<ProviderFailureKind, string | undefined> = {
    gone: "not produced",
    not_found: "not produced",
    rate_limited: "not produced",
    timed_out: "not produced",
    auth_failed: "not produced",
    ...overrides,
  };

  return Object.fromEntries(
    PROVIDER_FAILURE_KINDS.filter((kind) => complete[kind] !== undefined).map((kind) => [
      kind,
      complete[kind],
    ]),
  ) as FailureMapping;
}

const implementation: PlanImplementation = {
  name: "ExampleImplementation",
  slice: "1.1",
  owner: "@porkbot/adapters",
  status: "planned",
};

describe("the provider plan", () => {
  it("registers every interface this package declares exactly once", () => {
    const errors = validateProviderPlan({
      discovered: discoverInterfaces(),
      seams: PROVIDER_INTERFACES,
      shapes: PROVIDER_SHAPES,
    });

    expect(errors).toEqual([]);
  });

  it("proves the check fails on one implementation", () => {
    const errors = validateProviderPlan({
      discovered: [{ name: "Example", module: "./example.ts" }],
      seams: [
        {
          interface: "Example",
          module: "./example.ts",
          capability: "example",
          failures: completeMapping(),
          implementations: [implementation],
        },
      ],
      shapes: [],
    });

    expect(errors).toContain(
      "seam Example names 1 implementation(s); the rule requires at least two",
    );
  });

  it("proves the check fails on an undocumented failure kind", () => {
    const errors = validateProviderPlan({
      discovered: [{ name: "Example", module: "./example.ts" }],
      seams: [
        {
          interface: "Example",
          module: "./example.ts",
          capability: "example",
          failures: completeMapping({ timed_out: undefined }),
          implementations: [implementation, { ...implementation, name: "Second" }],
        },
      ],
      shapes: [],
    });

    expect(errors).toContain("seam Example does not document the timed_out failure");
  });

  it("proves the check fails on an unregistered interface", () => {
    const errors = validateProviderPlan({
      discovered: [
        { name: "Example", module: "./example.ts" },
        { name: "Drift", module: "./drift.ts" },
      ],
      seams: [
        {
          interface: "Example",
          module: "./example.ts",
          capability: "example",
          failures: completeMapping(),
          implementations: [implementation, { ...implementation, name: "Second" }],
        },
      ],
      shapes: [],
    });

    expect(errors).toContain(
      "Drift in ./drift.ts is unregistered: name at least two planned implementations in PROVIDER_INTERFACES, or list it in PROVIDER_SHAPES if it is data",
    );
  });

  it("proves the check fails on a slice-free implementation and a moved interface", () => {
    const errors = validateProviderPlan({
      discovered: [{ name: "Example", module: "./moved.ts" }],
      seams: [
        {
          interface: "Example",
          module: "./example.ts",
          capability: "example",
          failures: completeMapping(),
          implementations: [implementation, { ...implementation, name: "Second", slice: "later" }],
        },
      ],
      shapes: [],
    });

    expect(errors).toContain(
      'implementation Second of Example names no roadmap slice, got "later"',
    );
    expect(errors).toContain(
      "Example is registered in a seam in ./example.ts but declared in ./moved.ts",
    );
  });
});

describe("the seam package", () => {
  it("pins the vocabulary lifecycle code may branch on", () => {
    expect(PROVIDER_FAILURE_KINDS).toEqual([
      "gone",
      "not_found",
      "rate_limited",
      "timed_out",
      "auth_failed",
    ]);
  });

  it("imports nothing but its own modules", () => {
    const offenders = foreignImports(
      sourceModules().map((filename) => ({
        name: filename,
        source: readFileSync(path.join(sourceDir, filename), "utf8"),
      })),
    );

    expect(offenders).toEqual([]);
  });

  it("proves the import check fails on a vendor import", () => {
    expect(
      foreignImports([{ name: "example.ts", source: 'import OpenAI from "openai";' }]),
    ).toEqual(["example.ts imports openai"]);
    expect(
      foreignImports([{ name: "example.ts", source: 'import { readFile } from "node:fs";' }]),
    ).toEqual(["example.ts imports node:fs"]);
  });

  it("declares no runtime dependency", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(sourceDir, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies).toBeUndefined();
  });
});
