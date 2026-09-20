import { describe, expect, it } from "vitest";
import { parseServerOrigin } from "./server-origin.ts";

function originOf(input: string): string | undefined {
  const result = parseServerOrigin(input);

  return result.ok ? result.origin : undefined;
}

function refusalOf(input: string): string | undefined {
  const result = parseServerOrigin(input);

  return result.ok ? undefined : result.refusal;
}

describe("the server address", () => {
  it("reads a bare host as HTTPS", () => {
    expect(originOf("porkbot.example.com")).toBe("https://porkbot.example.com");
    expect(originOf("https://porkbot.example.com/")).toBe("https://porkbot.example.com");
    expect(originOf("  https://porkbot.example.com  ")).toBe("https://porkbot.example.com");
  });

  it("keeps a non-default port", () => {
    expect(originOf("https://porkbot.example.com:8443")).toBe("https://porkbot.example.com:8443");
    expect(originOf("https://porkbot.example.com:443")).toBe("https://porkbot.example.com");
  });

  it("allows plain HTTP only on this machine", () => {
    expect(originOf("http://localhost:3000")).toBe("http://localhost:3000");
    expect(originOf("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(originOf("http://[::1]:3000")).toBe("http://[::1]:3000");
    expect(refusalOf("http://porkbot.example.com")).toBe("insecure");
  });

  it("refuses credentials, paths and unknown schemes", () => {
    expect(refusalOf("https://operator:secret@porkbot.example.com")).toBe("has-credentials");
    expect(refusalOf("https://porkbot.example.com/rpc")).toBe("has-path");
    expect(refusalOf("https://porkbot.example.com/?token=1")).toBe("has-path");
    expect(refusalOf("ftp://porkbot.example.com")).toBe("unsupported-scheme");
  });

  it("refuses an empty or unreadable address with copy that says what to do", () => {
    expect(refusalOf("   ")).toBe("empty");
    expect(refusalOf("not a url")).toBe("malformed");

    const empty = parseServerOrigin("");

    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.message).toContain("Enter the address");
    }
  });
});
