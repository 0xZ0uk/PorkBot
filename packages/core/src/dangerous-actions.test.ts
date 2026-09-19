import { describe, expect, it } from "vitest";
import {
  classifyDangerousAction,
  connectorDangerousActions,
  DANGEROUS_ACTION_CLASSES,
  isCredentialStorePath,
  isDangerousActionClass,
} from "./dangerous-actions.ts";
import type { DangerousActionClass } from "./dangerous-actions.ts";
import { EMPTY_EGRESS_ALLOWLIST, parseEgressAllowlist } from "./egress-policy.ts";
import { COMPUTER_HOME_DIRECTORY } from "./files.ts";

/**
 * The policy in behaviour: each class in the register is reachable by a call
 * the tools actually make, each benign action in the same class stays safe, and
 * the classes are enumerated exactly once. This suite is the acceptance
 * criterion "each dangerous class is enumerated in one place" made executable:
 * a class added to the register without a rule fails the coverage test, and a
 * rule that fires on a benign action fails the same describe block.
 */

const home = COMPUTER_HOME_DIRECTORY;

function classify(
  tool: string,
  arguments_: unknown,
  declared: readonly DangerousActionClass[] | undefined = undefined,
  hosts: readonly string[] = [],
) {
  return classifyDangerousAction({
    tool,
    arguments: arguments_,
    home,
    allowlist: parseEgressAllowlist(hosts),
    declared,
  });
}

function danger(
  tool: string,
  arguments_: unknown,
  declared?: readonly DangerousActionClass[],
  hosts: readonly string[] = [],
) {
  const classification = classify(tool, arguments_, declared, hosts);

  return classification.verdict === "dangerous" ? classification.action : undefined;
}

describe("the class register", () => {
  it("enumerates the five classes the policy answers to", () => {
    expect(DANGEROUS_ACTION_CLASSES).toEqual([
      "credential_access",
      "write_outside_home",
      "egress_unlisted",
      "send",
      "delete",
    ]);
  });

  it("produces every enumerated class from a concrete call", () => {
    const calls: Record<DangerousActionClass, ReturnType<typeof danger>> = {
      credential_access: danger("file_read", { path: ".ssh/id_rsa" }, ["credential_access"]),
      write_outside_home: danger("file_write", { path: "/etc/hosts" }, ["write_outside_home"]),
      egress_unlisted: danger("web_fetch", { url: "https://other.test/page" }, ["egress_unlisted"]),
      send: danger("mcp_slack_send_message", { text: "hi" }, ["send"]),
      delete: danger("mcp_linear_delete_issue", { id: "1" }, ["delete"]),
    };

    for (const action of DANGEROUS_ACTION_CLASSES) {
      expect(calls[action]?.class, `no rule produced data-action "${action}"`).toBe(action);
      expect(calls[action]?.summary.length).toBeGreaterThan(0);
    }
  });

  it("recognizes only the registered classes", () => {
    expect(isDangerousActionClass("send")).toBe(true);
    expect(isDangerousActionClass("teleport")).toBe(false);
    expect(isDangerousActionClass(7)).toBe(false);
  });
});

describe("credential access", () => {
  it("flags a read of a credential store inside the home", () => {
    expect(danger("file_read", { path: ".ssh/id_rsa" }, ["credential_access"])).toMatchObject({
      class: "credential_access",
      summary: 'access the credential store ".ssh/id_rsa"',
    });
  });

  it("flags an absolute path through a credential directory", () => {
    expect(
      danger("file_read", { path: `${home}/.aws/credentials` }, ["credential_access"])?.class,
    ).toBe("credential_access");
  });

  it("flags a write into a credential store", () => {
    expect(
      danger("file_write", { path: ".ssh/authorized_keys" }, [
        "credential_access",
        "write_outside_home",
      ])?.class,
    ).toBe("credential_access");
  });

  it("flags a listing of a credential directory", () => {
    expect(danger("file_list", { path: ".gnupg" }, ["credential_access"])?.class).toBe(
      "credential_access",
    );
  });

  it("leaves an ordinary read inside the home alone", () => {
    expect(danger("file_read", { path: "notes/todo.md" }, ["credential_access"])).toBeUndefined();
    expect(danger("file_write", { path: "notes/todo.md" }, ["credential_access"])).toBeUndefined();
  });

  it("does not flag a credential-looking path for a tool that never declared it", () => {
    expect(danger("file_read", { path: ".ssh/id_rsa" })).toBeUndefined();
  });

  it("answers the store question on segments, not substrings", () => {
    expect(isCredentialStorePath(".ssh/id_rsa")).toBe(true);
    expect(isCredentialStorePath("backup/.env")).toBe(true);
    expect(isCredentialStorePath("s3crets/notes.md")).toBe(false);
    expect(isCredentialStorePath("environment.md")).toBe(false);
    expect(isCredentialStorePath("notes/ssh-keys.md")).toBe(false);
  });
});

describe("writing outside the home", () => {
  it("flags a relative path that climbs out", () => {
    expect(danger("file_write", { path: "../outside.txt" }, ["write_outside_home"])).toMatchObject({
      class: "write_outside_home",
      summary: `write outside the home to "/home/outside.txt"`,
    });
  });

  it("flags an absolute path outside the home", () => {
    expect(danger("file_write", { path: "/etc/hosts" }, ["write_outside_home"])).toMatchObject({
      class: "write_outside_home",
      summary: 'write outside the home to "/etc/hosts"',
    });
  });

  it("leaves a write inside the home alone", () => {
    expect(danger("file_write", { path: "notes/todo.md" }, ["write_outside_home"])).toBeUndefined();
    expect(
      danger("file_write", { path: `${home}/notes/todo.md` }, ["write_outside_home"]),
    ).toBeUndefined();
  });

  it("leaves a read tool alone even with an outside path", () => {
    expect(danger("file_read", { path: "/etc/hosts" }, ["credential_access"])).toBeUndefined();
  });
});

describe("unlisted egress", () => {
  it("flags a fetch of a host outside the allowlist", () => {
    expect(
      danger("web_fetch", { url: "https://other.test/page" }, ["egress_unlisted"]),
    ).toMatchObject({
      class: "egress_unlisted",
      summary: 'reach "other.test", which is not on this run\'s egress allowlist',
    });
  });

  it("leaves an allowlisted fetch alone", () => {
    expect(
      danger(
        "web_fetch",
        { url: "https://example.com/page" },
        ["egress_unlisted"],
        ["example.com"],
      ),
    ).toBeUndefined();
    expect(
      danger(
        "web_fetch",
        { url: "https://docs.example.com/page" },
        ["egress_unlisted"],
        ["*.example.com"],
      ),
    ).toBeUndefined();
  });

  it("refuses a URL that cannot be attributed to a host", () => {
    expect(classify("web_fetch", { url: "not a url" }, ["egress_unlisted"])).toEqual({
      verdict: "refused",
      reason: "invalid_url",
    });
  });

  it("does not classify a call with no URL at all", () => {
    expect(
      danger("browser", { action: "click", selector: "#send" }, ["egress_unlisted"]),
    ).toBeUndefined();
  });

  it("flags an empty allowlist, which is the default posture", () => {
    expect(
      classifyDangerousAction({
        tool: "web_fetch",
        arguments: { url: "https://example.com/page" },
        home,
        allowlist: EMPTY_EGRESS_ALLOWLIST,
        declared: ["egress_unlisted"],
      }),
    ).toMatchObject({ verdict: "dangerous", action: { class: "egress_unlisted" } });
  });
});

describe("connector send and delete", () => {
  it("declares a delete from a snake-case name", () => {
    expect(connectorDangerousActions("delete_issue")).toEqual(["delete"]);
    expect(connectorDangerousActions("forget_secret")).toEqual(["delete"]);
    expect(connectorDangerousActions("users.remove")).toEqual(["delete"]);
  });

  it("declares a send from a camel-case or dotted name", () => {
    expect(connectorDangerousActions("sendEmail")).toEqual(["send"]);
    expect(connectorDangerousActions("messages.send")).toEqual(["send"]);
    expect(connectorDangerousActions("publish_post")).toEqual(["send"]);
  });

  it("declares nothing for a read tool", () => {
    expect(connectorDangerousActions("list_issues")).toEqual([]);
    expect(connectorDangerousActions("get_weather")).toEqual([]);
    expect(connectorDangerousActions("search_pages")).toEqual([]);
  });

  it("flags each declared connector class with its tool named", () => {
    expect(danger("mcp_slack_send_message", { text: "hi" }, ["send"])).toMatchObject({
      class: "send",
      summary: 'send through the "mcp_slack_send_message" tool',
    });
    expect(danger("mcp_linear_delete_issue", { id: "1" }, ["delete"])).toMatchObject({
      class: "delete",
      summary: 'delete through the "mcp_linear_delete_issue" tool',
    });
  });

  it("leaves a connector read alone", () => {
    expect(
      danger("mcp_linear_list_issues", {}, connectorDangerousActions("list_issues")),
    ).toBeUndefined();
  });
});

describe("the tool surface the built-ins declare", () => {
  it("keeps a shell command outside the register", () => {
    const declared: readonly DangerousActionClass[] = [];

    expect(danger("shell", { command: "rm -rf /" }, declared)).toBeUndefined();
  });

  it("does not let a connector verb leak onto a built-in name", () => {
    expect(danger("memory_forget", { documentId: "1" }, [])).toBeUndefined();
  });
});
