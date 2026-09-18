import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BootstrappingScreen } from "./bootstrapping.tsx";

/**
 * The bootstrapping screen is what the router shows while a guard awaits the
 * session read; the built shell prerenders the same component, which the e2e
 * suite asserts against the artifact.
 */
describe("BootstrappingScreen", () => {
  it("announces the pending session check as a status", () => {
    const html = renderToStaticMarkup(<BootstrappingScreen />);

    expect(html).toContain('role="status"');
    expect(html).toContain("Checking your session");
    expect(html).toContain('id="main"');
  });
});
