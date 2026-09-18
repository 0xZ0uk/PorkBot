import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restrictedLibraries, workspacePackages } from "../module-boundaries.js";

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");

function workspacePackageNames() {
  const names = [];

  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const manifest = JSON.parse(
          readFileSync(path.join(repoRoot, group, entry.name, "package.json"), "utf8"),
        );
        names.push(manifest.name);
      }
    }
  }

  return names.sort();
}

describe("module map", () => {
  it("registers exactly the workspace packages", () => {
    expect(Object.keys(workspacePackages).sort()).toEqual(workspacePackageNames());
  });

  it("only references packages that exist", () => {
    const registered = new Set(Object.keys(workspacePackages));

    for (const [name, entry] of Object.entries(workspacePackages)) {
      for (const imported of entry.imports) {
        expect(registered.has(imported), `${name} imports ${imported}`).toBe(true);
      }

      for (const imported of entry.testImports ?? []) {
        expect(registered.has(imported), `${name} imports ${imported} in tests`).toBe(true);
      }

      // A package cannot test-import itself, and a test-only edge that is also a
      // production edge is a category error in the map.
      expect(entry.testImports ?? [], `${name} testImports`).not.toContain(name);
      for (const imported of entry.testImports ?? []) {
        expect(entry.imports, `${name} declares ${imported} twice`).not.toContain(imported);
      }
    }

    for (const { category, owners } of restrictedLibraries) {
      expect(owners.length, `${category} has an owner`).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(registered.has(owner), `${category} owner ${owner}`).toBe(true);
      }
    }
  });

  it("keeps core pure and adapters out of domain packages", () => {
    expect(workspacePackages["@porkbot/core"].imports).toEqual([]);

    const adapterImporters = Object.entries(workspacePackages)
      .filter(([, entry]) => entry.imports.includes("@porkbot/adapters"))
      .map(([name]) => name)
      .sort();

    // Only the surfaces that translate provider work — the HTTP/streaming
    // surface, the run executor and the computer lifecycle owner — plus the
    // testkit, which consumes adapters.
    expect(adapterImporters).toEqual([
      "@porkbot/api",
      "@porkbot/supervisor",
      "@porkbot/testkit",
      "@porkbot/worker",
    ]);
  });
});
