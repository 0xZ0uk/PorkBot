import { describe, expect, it } from "vitest";
import {
  cdpHttpBase,
  connectToPage,
  devToolsWebSocketUrl,
  firstPageTarget,
} from "../src/release/cdp.ts";
import {
  localServerOrigin,
  runSmokeFlow,
  setupScreenTitle,
  signedOutScreenTitle,
  waitForText,
} from "../src/release/smoke.ts";
import type { SmokeDriver } from "../src/release/smoke.ts";

function driverOver(screens: readonly string[]): {
  driver: SmokeDriver;
  submitted: string[];
} {
  const submitted: string[] = [];
  let index = 0;
  const last = screens.length - 1;

  return {
    submitted,
    driver: {
      readText: async () => screens[Math.min(index, last)] ?? "",
      setServerOrigin: async (value) => {
        submitted.push(value);
        index += 1;
        return true;
      },
    },
  };
}

describe("reading the debugging endpoint", () => {
  it("finds the WebSocket URL Chromium prints", () => {
    const line =
      "[12345:0920/101010.123456:INFO:CONSOLE(1)] DevTools listening on ws://127.0.0.1:41234/devtools/browser/2f0a";

    expect(devToolsWebSocketUrl(line)).toBe("ws://127.0.0.1:41234/devtools/browser/2f0a");
    expect(devToolsWebSocketUrl("nothing to see")).toBeUndefined();
  });

  it("derives the HTTP origin the target list lives on", () => {
    expect(cdpHttpBase("ws://127.0.0.1:41234/devtools/browser/2f0a")).toBe(
      "http://127.0.0.1:41234",
    );
    expect(cdpHttpBase("https://example.com/x")).toBeUndefined();
    expect(cdpHttpBase("not a url")).toBeUndefined();
  });

  it("gives up when no page target ever appears", async () => {
    await expect(
      connectToPage({
        listUrl: "http://127.0.0.1:1/json/list",
        timeoutMs: 20,
        pollMs: 5,
        fetch: (async () => new Response("[]", { status: 200 })) as typeof fetch,
      }),
    ).rejects.toThrow(/no debuggable page appeared/);
  });

  it("picks the app's page out of the target list, not the devtools frontend", () => {
    const targets = [
      { id: "1", type: "other", url: "ws://x", webSocketDebuggerUrl: "ws://1" },
      { id: "2", type: "page", url: "http://127.0.0.1:1/setup", webSocketDebuggerUrl: "ws://2" },
    ];

    expect(firstPageTarget(targets)?.webSocketDebuggerUrl).toBe("ws://2");
    expect(firstPageTarget({})).toBeUndefined();
  });
});

describe("the local server address", () => {
  it("accepts loopback HTTP and normalizes it to an origin", () => {
    expect(localServerOrigin("http://127.0.0.1:3199/")).toBe("http://127.0.0.1:3199");
    expect(localServerOrigin("http://localhost:3001")).toBe("http://localhost:3001");
    expect(localServerOrigin("http://[::1]:3199")).toBe("http://[::1]:3199");
  });

  it("refuses a remote host, HTTPS and a malformed address", () => {
    expect(() => localServerOrigin("https://porkbot.example.com")).toThrow(/loopback/);
    expect(() => localServerOrigin("http://192.168.1.10:3199")).toThrow(/loopback/);
    expect(() => localServerOrigin("not a url")).toThrow(/not a server URL/);
  });
});

describe("the smoke flow", () => {
  it("waits for the setup screen, submits the origin and waits for sign-in", async () => {
    const { driver, submitted } = driverOver([setupScreenTitle, signedOutScreenTitle]);

    await runSmokeFlow(driver, { serverUrl: "http://127.0.0.1:3199", pollMs: 1 });
    expect(submitted).toEqual(["http://127.0.0.1:3199"]);
  });

  it("fails with what the page said when a screen never appears", async () => {
    const { driver } = driverOver(["Something else entirely"]);

    await expect(
      waitForText(driver, setupScreenTitle, { timeoutMs: 20, pollMs: 1 }),
    ).rejects.toThrow(/never showed "Connect PorkBot".*Something else entirely/s);
  });

  it("fails when the setup page offers no form to submit", async () => {
    const driver: SmokeDriver = {
      readText: async () => setupScreenTitle,
      setServerOrigin: async () => false,
    };

    await expect(
      runSmokeFlow(driver, { serverUrl: "http://127.0.0.1:3199", pollMs: 1, timeoutMs: 20 }),
    ).rejects.toThrow(/no server address form/);
  });
});
