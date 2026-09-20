import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import type { DeploymentSettings } from "@porkbot/core";
import type { UserActor, UserRepositories } from "@porkbot/db";
import { DeploymentSettingsConflictError } from "@porkbot/effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../server.ts";
import { createDeploymentService } from "../services/deployment.ts";

/**
 * The account surface through the real transport (slice 11.5): who the actor
 * is, and who owns the deployment it acts in.
 *
 * The deployment reader is the seam this suite varies: a configured admin
 * address answers the owner, a missing one answers `null` rather than an
 * invented address, and a settings table that disagrees with itself is the
 * contract's typed 503 instead of a claim in either direction. The
 * repositories stand-in is never exercised — neither procedure reads tenant
 * data — which is itself part of the point: ownership is deployment state,
 * not space state.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const member: UserActor = { kind: "user", spaceId: "space-1", userId: "user-2", role: "member" };

let sessionActor: UserActor | null = owner;
let settings: DeploymentSettings | null = {
  signupsEnabled: true,
  adminEmail: "owner@example.test",
};
let conflict = false;

const deployment = createDeploymentService(async () => {
  if (conflict) {
    throw new DeploymentSettingsConflictError(2);
  }

  return settings;
});

const server = createApiServer({
  services: { deployment, realtime: new InProcessRealtimeFanout() },
  resolveActor: async () => sessionActor,
  // Neither procedure this suite calls reads a repository; the gate requires
  // a non-null scope for the authenticated path, and the cast says the stand-in
  // is deliberately incomplete.
  repositoriesFor: (actor) => ({ actor }) as unknown as UserRepositories,
});

let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected the API to listen on a TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("the account ownership surface", () => {
  it("pairs the actor's role with the deployment's configured owner", async () => {
    sessionActor = owner;
    settings = { signupsEnabled: true, adminEmail: "owner@example.test" };
    conflict = false;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(client.account.ownership()).resolves.toEqual({
      role: "owner",
      ownerEmail: "owner@example.test",
    });
  });

  it("answers the actor's own role, not a role it was told", async () => {
    sessionActor = member;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(client.account.ownership()).resolves.toEqual({
      role: "member",
      ownerEmail: "owner@example.test",
    });
  });

  it("answers a null owner when the deployment configured none", async () => {
    sessionActor = owner;
    settings = { signupsEnabled: true, adminEmail: null };

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(client.account.ownership()).resolves.toEqual({
      role: "owner",
      ownerEmail: null,
    });
  });

  it("answers the typed 503 when the settings table disagrees with itself", async () => {
    conflict = true;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.account.ownership().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503, defined: true });
  });

  it("answers the typed 401 without a session", async () => {
    conflict = false;
    sessionActor = null;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.account.ownership().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});
