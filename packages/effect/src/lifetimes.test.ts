import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { processSingleton, processTag, requestScoped, requestTag } from "./lifetimes.ts";
import type { ProcessTag } from "./lifetimes.ts";

/**
 * The lifetime rules (PRD decision 27) in behaviour and in type.
 *
 * The runtime half shows the difference: a process singleton is acquired once
 * and finalized once, while a request-scoped layer is acquired and finalized
 * for each request. The compile-time half is the one that prevents the actual
 * bug — a repository built for one actor (or none) becoming a boot-time
 * singleton — so the `@ts-expect-error` lines below are assertions: if the
 * guard ever stops rejecting those layers, the typecheck fails.
 */

interface PoolShape {
  readonly connections: number;
}

interface RepositoryShape {
  readonly actorId: string;
}

const Pool = processTag<PoolShape>("test/Pool");
const Repositories = requestTag<RepositoryShape>("test/Repositories");
const ProcessDerived = processTag<{ readonly poolSize: number }>("test/ProcessDerived");

function poolLayer(events: string[]): Layer.Layer<ProcessTag<PoolShape>> {
  return Layer.scoped(
    Pool,
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push("acquire pool");
        return { connections: 3 };
      }),
      () => Effect.sync(() => events.push("release pool")),
    ),
  );
}

describe("a process singleton", () => {
  it("is acquired once, shared by every consumer, and released once when the scope closes", async () => {
    const events: string[] = [];
    const layer = processSingleton(poolLayer(events));
    const program = Effect.gen(function* () {
      const first = (yield* Pool).connections;
      const second = (yield* Pool).connections;
      return first + second;
    });

    const result = await Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    expect(result).toBe(6);
    expect(events).toEqual(["acquire pool", "release pool"]);
  });
});

describe("a request-scoped layer", () => {
  it("is acquired and released once per request scope", async () => {
    const events: string[] = [];
    const layer = requestScoped(
      Layer.scoped(
        Repositories,
        Effect.acquireRelease(
          Effect.sync(() => {
            events.push("acquire repositories");
            return { actorId: "user-1" };
          }),
          () => Effect.sync(() => events.push("release repositories")),
        ),
      ),
    );
    const program = Effect.gen(function* () {
      return (yield* Repositories).actorId;
    });
    const run = () => Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(layer))));

    await expect(run()).resolves.toBe("user-1");
    await expect(run()).resolves.toBe("user-1");

    expect(events).toEqual([
      "acquire repositories",
      "release repositories",
      "acquire repositories",
      "release repositories",
    ]);
  });
});

describe("the process-singleton guard", () => {
  it("refuses a layer that provides a request-scoped service", () => {
    const repositories = requestScoped(Layer.succeed(Repositories, { actorId: "user-1" }));

    expect(() => {
      // @ts-expect-error a request-scoped repository is not ProcessScoped, so it cannot be
      // blessed as a boot-time singleton.
      processSingleton(repositories);
    }).not.toThrow();
  });

  it("refuses a layer that requires a request-scoped service", () => {
    const derived = Layer.effect(
      ProcessDerived,
      Effect.map(Repositories, (repositories) => ({ poolSize: repositories.actorId.length })),
    );

    expect(() => {
      // @ts-expect-error the requirement is request-scoped, so this layer's own lifetime cannot
      // be the process.
      processSingleton(derived);
    }).not.toThrow();
  });

  it("accepts a layer built only from process-scoped services", () => {
    const layer = processSingleton(poolLayer([]));

    expect(layer).toBeDefined();
  });

  it("accepts a process layer that depends on another process layer", () => {
    const derived = Layer.effect(
      ProcessDerived,
      Effect.map(Pool, (pool) => ({ poolSize: pool.connections })),
    );
    const layer = processSingleton(Layer.provide(derived, poolLayer([])));

    expect(layer).toBeDefined();
  });
});

describe("the request-scoped marker", () => {
  it("refuses a tag that has not declared a lifetime", () => {
    const plain = Context.GenericTag<{ readonly actorId: string }>("test/PlainTag");

    expect(() => {
      // @ts-expect-error a plain tag has no lifetime; only a requestTag may be
      // declared request-scoped.
      requestScoped(Layer.succeed(plain, { actorId: "user-1" }));
    }).not.toThrow();
  });
});
