import { describe, expect, it } from "vitest";
import { decideNavigation } from "./navigation.ts";

const appOrigin = "http://127.0.0.1:49152";

describe("window navigation", () => {
  it("allows the app's own origin, ports and all", () => {
    expect(decideNavigation({ url: `${appOrigin}/threads/one`, appOrigin, frame: "main" })).toEqual(
      { action: "allow" },
    );
    expect(decideNavigation({ url: "http://127.0.0.1:49152", appOrigin, frame: "main" })).toEqual({
      action: "allow",
    });
  });

  it("opens an HTTPS link in the system browser rather than in the window", () => {
    const decision = decideNavigation({
      url: "https://porkbot.example.com/docs",
      appOrigin,
      frame: "main",
    });

    expect(decision).toEqual({
      action: "open-external",
      url: "https://porkbot.example.com/docs",
    });
  });

  it("refuses a foreign plain-HTTP page", () => {
    expect(decideNavigation({ url: "http://evil.example.com/", appOrigin, frame: "main" })).toEqual(
      {
        action: "deny",
        reason: "unsupported-scheme",
      },
    );
  });

  it("refuses script, file and data destinations", () => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<h1>x</h1>"]) {
      expect(decideNavigation({ url, appOrigin, frame: "main" }), url).toEqual({
        action: "deny",
        reason: "unsupported-scheme",
      });
    }
  });

  it("refuses an unreadable destination", () => {
    expect(decideNavigation({ url: "not a url", appOrigin, frame: "main" })).toEqual({
      action: "deny",
      reason: "malformed",
    });
  });

  it("refuses a foreign frame outright, even an HTTPS one", () => {
    expect(
      decideNavigation({ url: "https://embed.example.com/", appOrigin, frame: "subframe" }),
    ).toEqual({ action: "deny", reason: "foreign-origin" });
    expect(decideNavigation({ url: `${appOrigin}/frame`, appOrigin, frame: "subframe" })).toEqual({
      action: "allow",
    });
  });

  it("treats the same origin written differently as the app's own", () => {
    expect(decideNavigation({ url: "HTTP://127.0.0.1:49152/", appOrigin, frame: "main" })).toEqual({
      action: "allow",
    });
  });
});
