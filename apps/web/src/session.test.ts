import { describe, expect, it, vi } from "vitest";
import { AuthRefusal, createSessionController } from "./session.ts";
import type { AuthTransport, SessionActor, SignupAvailability } from "./session.ts";

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

function transportWith(overrides: Partial<AuthTransport> = {}): AuthTransport {
  return {
    currentActor: vi.fn(async () => null as SessionActor | null),
    signIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signupAvailability: vi.fn(async () => "open" as SignupAvailability),
    ...overrides,
  };
}

describe("the session controller", () => {
  it("starts bootstrapping and resolves an anonymous session to signed-out", async () => {
    const controller = createSessionController({ transport: transportWith() });

    expect(controller.state()).toEqual({ status: "bootstrapping" });
    await expect(controller.ensure()).resolves.toEqual({ status: "signed-out" });
  });

  it("resolves a membership to the signed-in actor", async () => {
    const controller = createSessionController({
      transport: transportWith({ currentActor: async () => actor }),
    });

    await expect(controller.ensure()).resolves.toEqual({ status: "signed-in", actor });
  });

  it("reads the session once for concurrent guards", async () => {
    const currentActor = vi.fn(async () => actor);
    const controller = createSessionController({ transport: transportWith({ currentActor }) });

    const [first, second] = await Promise.all([controller.ensure(), controller.ensure()]);

    expect(first).toEqual({ status: "signed-in", actor });
    expect(second).toEqual(first);
    expect(currentActor).toHaveBeenCalledTimes(1);
  });

  it("reuses the resolved state instead of re-reading on every navigation", async () => {
    const currentActor = vi.fn(async () => actor);
    const controller = createSessionController({ transport: transportWith({ currentActor }) });

    await controller.ensure();
    await controller.ensure();

    expect(currentActor).toHaveBeenCalledTimes(1);
  });

  it("reports an unavailable server rather than a signed-out visitor", async () => {
    const currentActor = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const controller = createSessionController({ transport: transportWith({ currentActor }) });

    await expect(controller.ensure()).resolves.toEqual({ status: "unavailable" });
  });

  it("retries a failed read on reload", async () => {
    let fail = true;
    const controller = createSessionController({
      transport: transportWith({
        currentActor: async () => {
          if (fail) {
            throw new Error("connection refused");
          }

          return actor;
        },
      }),
    });

    await controller.ensure();
    expect(controller.state().status).toBe("unavailable");

    fail = false;
    await expect(controller.reload()).resolves.toEqual({ status: "signed-in", actor });
  });

  it("signs in, then reads the actor back through the session resolver", async () => {
    const currentActor = vi.fn(async () => actor);
    const signIn = vi.fn(async () => undefined);
    const controller = createSessionController({
      transport: transportWith({ currentActor, signIn }),
    });

    await controller.signIn({ email: "operator@example.invalid", password: "correct-horse" });

    expect(signIn).toHaveBeenCalledWith({
      email: "operator@example.invalid",
      password: "correct-horse",
    });
    expect(controller.state()).toEqual({ status: "signed-in", actor });
  });

  it("keeps a refused credential a refusal, not a state change", async () => {
    const controller = createSessionController({
      transport: transportWith({
        signIn: async () => {
          throw new AuthRefusal("refused", "Invalid email or password.");
        },
      }),
    });

    await expect(
      controller.signIn({ email: "operator@example.invalid", password: "wrong" }),
    ).rejects.toThrowError("Invalid email or password.");
  });

  it("reports a sign-in that produced no session instead of claiming one", async () => {
    const controller = createSessionController({
      transport: transportWith({ currentActor: async () => null }),
    });

    await expect(
      controller.signIn({ email: "operator@example.invalid", password: "correct-horse" }),
    ).rejects.toMatchObject({ reason: "not_signed_in" });
  });

  it("signs out to the anonymous state and tells every listener", async () => {
    const controller = createSessionController({
      transport: transportWith({ currentActor: async () => actor }),
    });
    const listener = vi.fn();
    controller.subscribe(listener);

    await controller.ensure();
    await controller.signOut();

    expect(controller.state()).toEqual({ status: "signed-out" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
