import { createMemoryCredentialStore, InProcessRealtimeFanout } from "@porkbot/adapters";
import { signWebhookBody, webhookDeliveryHeader, webhookSignatureHeader } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import type { DeliveryLedger, RecordWebhookDeliveryInput } from "@porkbot/db";
import { describe, expect, it } from "vitest";
import { createApiApp, serviceName } from "./app.ts";
import type { ApiServices } from "./app.ts";
import { createWebhookIngress, webhookSecretName } from "./webhooks.ts";
import type {
  WebhookEvent,
  WebhookHandler,
  WebhookIngress,
  WebhookOutcome,
  WebhookRequest,
} from "./webhooks.ts";
import type { DeploymentStatus } from "./services/deployment.ts";

/**
 * The verified ingress, against the protocol and over HTTP.
 *
 * The acceptance criteria this suite proves: a signature is checked over the
 * raw bytes before anything parses them and an unsigned or wrongly-signed
 * request never reaches a handler; the freshness window refuses an old
 * signature; a replay of the same delivery id is a no-op; and the route runs
 * under the unauthenticated principal, so it never reads a session.
 */

const source = "github";
const secret = "webhook-signing-secret-placeholder";
const nowMs = Date.parse("2026-09-18T12:00:00.000Z");
const nowSeconds = Math.floor(nowMs / 1_000);
const bodyText = '{"action":"opened","number":44}';
const body = new TextEncoder().encode(bodyText);

const services: ApiServices = {
  deployment: {
    async status(): Promise<DeploymentStatus> {
      return { kind: "closed" };
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

/** A ledger with the dedupe semantics the database provides. */
class FakeLedger implements DeliveryLedger {
  readonly recorded: string[] = [];
  readonly released: string[] = [];
  failRelease = false;
  private readonly deliveries = new Set<string>();

  record(input: RecordWebhookDeliveryInput): Promise<boolean> {
    const key = `${input.source}\u0000${input.deliveryId}`;
    const fresh = !this.deliveries.has(key);

    if (fresh) {
      this.deliveries.add(key);
    }

    this.recorded.push(key);
    return Promise.resolve(fresh);
  }

  release(input: { source: string; deliveryId: string }): Promise<void> {
    if (this.failRelease) {
      return Promise.reject(new Error("the release failed"));
    }

    this.deliveries.delete(`${input.source}\u0000${input.deliveryId}`);
    this.released.push(`${input.source}\u0000${input.deliveryId}`);
    return Promise.resolve();
  }
}

interface Harness {
  readonly ingress: WebhookIngress;
  readonly ledger: FakeLedger;
  readonly handled: WebhookEvent[];
  readonly lines: string[];
  readonly handler: WebhookHandler;
}

function harness(
  options: {
    readonly configureSecret?: boolean;
    readonly handler?: WebhookHandler;
  } = {},
): Harness {
  const ledger = new FakeLedger();
  const handled: WebhookEvent[] = [];
  const lines: string[] = [];
  const logger = createLogger({ service: serviceName, write: (line) => lines.push(line) });
  const handler =
    options.handler ??
    ((event: WebhookEvent) => {
      handled.push(event);
      return Promise.resolve();
    });
  const secrets =
    options.configureSecret === false
      ? createMemoryCredentialStore()
      : createMemoryCredentialStore([[webhookSecretName(source), secret]]);

  const ingress = createWebhookIngress({
    secrets,
    deliveries: ledger,
    handlers: new Map([[source, handler]]),
    logger,
    now: () => new Date(nowMs),
  });

  return { ingress, ledger, handled, lines, handler };
}

function signedRequest(
  overrides: Partial<WebhookRequest> = {},
  timestampSeconds = nowSeconds,
): WebhookRequest {
  return {
    source,
    signature: signWebhookBody(secret, { timestampSeconds, body }),
    deliveryId: "delivery-1",
    body,
    ...overrides,
  };
}

async function recordsOf(lines: readonly string[]): Promise<Record<string, unknown>[]> {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

describe("the ingress protocol", () => {
  it("accepts a signed request and hands the handler the exact unparsed body", async () => {
    const test = harness();
    const raw = new TextEncoder().encode('  {"action":"opened"}\n');
    const request = {
      source,
      signature: signWebhookBody(secret, { timestampSeconds: nowSeconds, body: raw }),
      deliveryId: "delivery-raw",
      body: raw,
    };

    await expect(test.ingress.receive(request)).resolves.toEqual({ status: "accepted" });

    expect(test.handled).toEqual([{ source, deliveryId: "delivery-raw", body: raw }]);
    expect(test.ledger.recorded).toEqual([`${source}\u0000delivery-raw`]);
  });

  it("accepts a binary body by verifying the exact bytes, not a decoded string", async () => {
    const test = harness();
    const binary = new Uint8Array([0x80, 0xff, 0x00, 0x41, 0xfe]);
    const request = {
      source,
      signature: signWebhookBody(secret, { timestampSeconds: nowSeconds, body: binary }),
      deliveryId: "delivery-binary",
      body: binary,
    };

    await expect(test.ingress.receive(request)).resolves.toEqual({ status: "accepted" });

    expect(test.handled).toEqual([{ source, deliveryId: "delivery-binary", body: binary }]);
  });

  it("treats a replay of the same delivery id as a no-op", async () => {
    const test = harness();

    await expect(test.ingress.receive(signedRequest())).resolves.toEqual({ status: "accepted" });
    await expect(test.ingress.receive(signedRequest())).resolves.toEqual({ status: "duplicate" });

    expect(test.handled).toHaveLength(1);
    expect(test.ledger.recorded).toHaveLength(2);
  });

  it("refuses an unknown source before touching the ledger", async () => {
    const test = harness();

    await expect(
      test.ingress.receive({ ...signedRequest(), source: "unknown-source" }),
    ).resolves.toEqual({ status: "rejected", reason: "unknown_source" });

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("refuses a registered source whose secret is not configured", async () => {
    const test = harness({ configureSecret: false });

    await expect(test.ingress.receive(signedRequest())).resolves.toEqual({
      status: "rejected",
      reason: "unconfigured_source",
    });

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("never reaches the handler for a missing or malformed signature", async () => {
    const cases: readonly [string | undefined, WebhookOutcome][] = [
      [undefined, { status: "rejected", reason: "missing_signature" }],
      ["", { status: "rejected", reason: "malformed_signature" }],
      ["t=not-a-number,v1=ab", { status: "rejected", reason: "malformed_signature" }],
      [`t=${nowSeconds},v1=`, { status: "rejected", reason: "malformed_signature" }],
    ];

    for (const [signature, expected] of cases) {
      const test = harness();

      await expect(test.ingress.receive(signedRequest({ signature }))).resolves.toEqual(expected);

      expect(test.handled).toHaveLength(0);
      expect(test.ledger.recorded).toHaveLength(0);
    }
  });

  it("refuses a signature older than the freshness window even with a known delivery id", async () => {
    const test = harness();
    const stale = signedRequest({}, nowSeconds - 301);

    await expect(test.ingress.receive(stale)).resolves.toEqual({
      status: "rejected",
      reason: "stale_signature",
    });

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("refuses a far-future or mismatched signature without dispatching", async () => {
    const test = harness();
    const future = signedRequest({}, nowSeconds + 301);
    const wrongSecret = {
      ...signedRequest(),
      signature: signWebhookBody("another-secret", { timestampSeconds: nowSeconds, body }),
    };

    await expect(test.ingress.receive(future)).resolves.toEqual({
      status: "rejected",
      reason: "future_signature",
    });
    await expect(test.ingress.receive(wrongSecret)).resolves.toEqual({
      status: "rejected",
      reason: "bad_signature",
    });
    await expect(
      test.ingress.receive({ ...signedRequest(), body: new TextEncoder().encode(`${bodyText} `) }),
    ).resolves.toEqual({ status: "rejected", reason: "bad_signature" });

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("refuses a signed request with no usable delivery id instead of dispatching it", async () => {
    const test = harness();

    await expect(test.ingress.receive(signedRequest({ deliveryId: undefined }))).resolves.toEqual({
      status: "rejected",
      reason: "missing_delivery",
    });
    await expect(test.ingress.receive(signedRequest({ deliveryId: "   " }))).resolves.toEqual({
      status: "rejected",
      reason: "missing_delivery",
    });
    await expect(
      test.ingress.receive(signedRequest({ deliveryId: "d".repeat(201) })),
    ).resolves.toEqual({ status: "rejected", reason: "invalid_delivery" });

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("refuses a source name outside the canonical shape", async () => {
    const test = harness();

    for (const invalid of ["GitHub", "my_source", "my source", "-leading", "trailing-", ""]) {
      await expect(test.ingress.receive({ ...signedRequest(), source: invalid })).resolves.toEqual({
        status: "rejected",
        reason: "unknown_source",
      });
    }

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("releases the delivery and rethrows when the handler fails, so a redelivery is dispatched", async () => {
    const failure = new Error("the handler failed");
    const test = harness({
      handler: () => Promise.reject(failure),
    });
    const request = signedRequest();

    await expect(test.ingress.receive(request)).rejects.toBe(failure);
    expect(test.ledger.released).toEqual([`${source}\u0000delivery-1`]);

    await expect(test.ingress.receive(request)).rejects.toBe(failure);
    expect(test.ledger.recorded).toHaveLength(2);
  });

  it("keeps the handler's failure visible when the release also fails", async () => {
    const failure = new Error("the handler failed");
    const test = harness({ handler: () => Promise.reject(failure) });

    test.ledger.failRelease = true;

    await expect(test.ingress.receive(signedRequest())).rejects.toBe(failure);

    const records = await recordsOf(test.lines);
    expect(records.map((record) => record["msg"])).toContain(
      "failed to release a webhook delivery",
    );
  });

  it("logs refusals with the reason and never the body or the secret", async () => {
    const test = harness();

    await test.ingress.receive(signedRequest({}, nowSeconds - 301));

    const records = await recordsOf(test.lines);
    const refusal = records.find((record) => record["msg"] === "webhook signature was refused");

    expect(refusal).toMatchObject({ source, reason: "stale" });
    expect(test.lines.join("\n")).not.toContain(secret);
    expect(test.lines.join("\n")).not.toContain("opened");
  });
});

describe("the mounted surface", () => {
  function surface(test: Harness) {
    return createApiApp({
      services,
      webhooks: test.ingress,
      clientKey: () => "test-client",
      // A webhook is unauthenticated: reading a session here is the bug this
      // resolver would make visible, because it throws.
      resolveActor: () => Promise.reject(new Error("a webhook must not read a session")),
    });
  }

  function post(app: ReturnType<typeof createApiApp>, request: WebhookRequest) {
    return app.request(`/webhooks/${request.source}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(request.signature === undefined ? {} : { [webhookSignatureHeader]: request.signature }),
        ...(request.deliveryId === undefined
          ? {}
          : { [webhookDeliveryHeader]: request.deliveryId }),
      },
      // The DOM lib arrives with vitest's optional jsdom types (the tier
      // presets pull `vitest/config`, and this package's integration suite
      // imports the harness), and its `BodyInit` is narrower than the bytes
      // the ingress actually takes; the encoded body is ArrayBuffer-backed.
      body: request.body as Uint8Array<ArrayBuffer>,
    });
  }

  it("answers an accepted delivery with 202 and a replay with a 200 no-op", async () => {
    const test = harness();
    const app = surface(test);

    const first = await post(app, signedRequest());

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "accepted" });

    const second = await post(app, signedRequest());

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ status: "ignored" });
    expect(test.handled).toHaveLength(1);
  });

  it("answers an unsigned, wrongly-signed or stale request with 401 and dispatches nothing", async () => {
    const test = harness();
    const app = surface(test);

    const unsigned = await post(app, { ...signedRequest(), signature: undefined });
    const wrong = await post(app, {
      ...signedRequest(),
      signature: signWebhookBody("another-secret", { timestampSeconds: nowSeconds, body }),
    });
    const stale = await post(app, signedRequest({}, nowSeconds - 301));

    for (const response of [unsigned, wrong, stale]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }

    expect(test.handled).toHaveLength(0);
    expect(test.ledger.recorded).toHaveLength(0);
  });

  it("answers a missing delivery id with 400 and an unknown source with 401", async () => {
    const test = harness();
    const app = surface(test);

    const noDelivery = await post(app, signedRequest({ deliveryId: undefined }));
    const unknown = await post(app, signedRequest({ source: "nobody" }));

    expect(noDelivery.status).toBe(400);
    expect(await noDelivery.json()).toEqual({ error: "bad_request" });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toEqual({ error: "unauthorized" });
  });

  it("answers a handler failure with 500 so the provider retries", async () => {
    const test = harness({ handler: () => Promise.reject(new Error("the handler failed")) });
    const app = surface(test);

    const response = await post(app, signedRequest());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
    expect(test.ledger.released).toHaveLength(1);
  });

  it("passes a body that is not JSON to a verified handler unparsed", async () => {
    const handled: WebhookEvent[] = [];
    const test = harness({
      handler: (event) => {
        handled.push(event);
        return Promise.resolve();
      },
    });
    const app = surface(test);
    const raw = new TextEncoder().encode("not json at all");

    const response = await post(app, {
      source,
      signature: signWebhookBody(secret, { timestampSeconds: nowSeconds, body: raw }),
      deliveryId: "delivery-non-json",
      body: raw,
    });

    expect(response.status).toBe(202);
    expect(handled).toEqual([{ source, deliveryId: "delivery-non-json", body: raw }]);
  });

  it("hands a verified handler provider data and nothing actor-shaped", async () => {
    const handled: WebhookEvent[] = [];
    const test = harness({
      handler: (event) => {
        handled.push(event);
        return Promise.resolve();
      },
    });
    const app = surface(test);

    await post(app, signedRequest());

    // The ingress is the one unauthenticated write surface: no resolved actor,
    // no space and no repository rides along, so a handler cannot mistake the
    // caller for a tenant or reach rows through borrowed authority.
    expect(Object.keys(handled[0] ?? {}).sort()).toEqual(["body", "deliveryId", "source"]);
  });

  it("caps the webhook body before the signature is read", async () => {
    const test = harness();
    const app = createApiApp({
      services,
      webhooks: test.ingress,
      clientKey: () => "test-client",
      limits: { webhook: { requestsPerMinute: 120, maxBodyBytes: 64 } },
    });

    const response = await app.request(`/webhooks/${source}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_024),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "payload_too_large", maxBytes: 64 });
  });
});
