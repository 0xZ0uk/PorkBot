import { describe, expect, it } from "vitest";
import {
  assertComputerNetworkPlan,
  COMPUTER_NETWORK_PREFIX,
  computerNetworkPlanProblems,
  MAX_COMPUTER_NETWORK_NAME_LENGTH,
  planComputerNetwork,
  RESERVED_NETWORK_NAMES,
} from "./computer-network.ts";
import type { ComputerNetworkPlan } from "./computer-network.ts";

/**
 * The isolation policy's own tests. The provider integration suite proves the
 * network a plan describes behaves the way the plan says; this suite proves the
 * derivation, so the property "two computers never share a network" is checked
 * over ids a human would not think to try, and the guard is exercised against
 * every way a plan can stop being internal.
 */

const computer = { computerId: "computer-1", botId: "bot-1" } as const;

function planFor(botId: string, computerId: string): ComputerNetworkPlan {
  return planComputerNetwork({ botId, computerId });
}

describe("the per-computer network plan", () => {
  it("derives a stable, prefixed name from the computer's identity", () => {
    const first = planComputerNetwork(computer);
    const second = planComputerNetwork(computer);

    expect(first).toEqual(second);
    expect(first.name.startsWith(`${COMPUTER_NETWORK_PREFIX}-bot-1-`)).toBe(true);
  });

  it("gives two computers different networks even when their ids sanitize alike", () => {
    const identities = [
      ["bot-1", "computer-1"],
      ["bot-1", "computer-2"],
      ["bot-2", "computer-1"],
      ["bot-1!", "computer-1!"],
      ["BOT-1", "COMPUTER-1"],
      ["bot/1", "computer/1"],
      ["bot_1", "computer_1"],
      ["bot-1", "computer-1"],
    ] as const;

    const names = new Set(identities.map(([botId, computerId]) => planFor(botId, computerId).name));

    // Every pair is distinct, including the repeated one, and the ids that
    // sanitize to the same stem are kept apart by the hash.
    expect(names.size).toBe(7);
    expect(planFor("bot/1", "computer/1").name).not.toBe(planFor("bot_1", "computer_1").name);
  });

  it("keeps every name inside Docker's grammar and away from its reserved names", () => {
    const plans = [
      planFor("bot-1", "computer-1"),
      planFor("B".repeat(200), "C".repeat(200)),
      planFor("bot with spaces", "computer\nwith\nnewlines"),
      planFor("b".repeat(64), "c".repeat(64)),
    ];

    for (const plan of plans) {
      expect(plan.name).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
      expect(plan.name.length).toBeLessThanOrEqual(MAX_COMPUTER_NETWORK_NAME_LENGTH);
      expect(plan.name).not.toBe("");
      expect(RESERVED_NETWORK_NAMES as readonly string[]).not.toContain(plan.name);
      expect(computerNetworkPlanProblems(plan)).toEqual([]);
    }
  });

  it("refuses to derive a network from a blank identity", () => {
    expect(() => planFor("", "computer-1")).toThrow(RangeError);
    expect(() => planFor("bot-1", "   ")).toThrow(RangeError);
  });

  it("states the whole boundary, so a provider cannot lose a field to a default", () => {
    const plan = planComputerNetwork(computer);

    expect(plan.name).toMatch(/^porkbot-bot-bot-1-computer-1-[0-9a-f]{8}$/);
    expect(plan).toEqual({
      name: plan.name,
      driver: "bridge",
      internal: true,
      gatewayMode: "isolated",
      hostNetwork: false,
      publishPorts: false,
    });
  });
});

describe("the network-plan guard", () => {
  it("passes a plan the derivation produced", () => {
    const plan = planComputerNetwork(computer);

    expect(assertComputerNetworkPlan(plan)).toBe(plan);
  });

  it("refuses every way a plan can leave the isolation boundary", () => {
    const plan = planComputerNetwork(computer);

    const broken = [
      { ...plan, name: "some-other-network", problem: "not_prefixed" },
      { ...plan, name: "host", problem: "not_prefixed" },
      { ...plan, name: "bridge", problem: "not_prefixed" },
      { ...plan, name: `${COMPUTER_NETWORK_PREFIX}-${"x".repeat(80)}`, problem: "name_too_long" },
      { ...plan, internal: false as unknown as true, problem: "external_route" },
      { ...plan, driver: "host" as unknown as "bridge", problem: "external_route" },
      { ...plan, gatewayMode: "nat" as unknown as "isolated", problem: "reachable_gateway" },
      { ...plan, hostNetwork: true as unknown as false, problem: "host_network" },
      { ...plan, publishPorts: true as unknown as false, problem: "published_ports" },
    ] as const;

    for (const { problem, ...candidate } of broken) {
      const planProblems = computerNetworkPlanProblems(candidate as ComputerNetworkPlan);

      expect(planProblems, `${problem} was not detected`).toContain(problem);
      expect(() => assertComputerNetworkPlan(candidate as ComputerNetworkPlan)).toThrow(RangeError);
    }
  });

  it("names every broken property when a plan breaks more than one", () => {
    const broken = {
      name: "host",
      driver: "bridge",
      internal: false,
      gatewayMode: "nat",
      hostNetwork: true,
      publishPorts: true,
    } as unknown as ComputerNetworkPlan;

    expect(computerNetworkPlanProblems(broken)).toEqual([
      "not_prefixed",
      "reserved_name",
      "external_route",
      "reachable_gateway",
      "host_network",
      "published_ports",
    ]);
  });
});
