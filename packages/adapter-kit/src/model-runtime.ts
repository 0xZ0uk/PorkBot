import type { FailureMapping } from "./failures.ts";

/**
 * The model runtime seam (PRD decisions 12, 13, 29; stories 12, 13).
 *
 * The agent loop talks to a model endpoint through this interface, so "which
 * model, where it runs and whose key pays for it" is a connection decision
 * rather than a code path. A deployment can point at a hosted OpenAI-compatible
 * endpoint or at a self-hosted one by URL and key (slice 9.2) — the provider
 * adapter speaks the wire protocol, the loop consumes provider-neutral events —
 * and the offline emulator (slice 5.4) speaks the same wire protocol with
 * scripted, deterministic responses so the whole run lifecycle is exercisable
 * with no keys and no network.
 *
 * A `ModelConnection` carries the credential's *name*, never its value: the
 * adapter resolves it through `CredentialStore`, and no provider-specific
 * environment variable exists. The endpoint URL is caller-supplied and is
 * validated by the URL-safety module (slice 4.6) inside the implementation
 * before the first byte leaves the process.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. Lifecycle
 * code decides retry, model fallback and operator escalation from the kind and
 * never reads a vendor message.
 */

/** Where a model endpoint lives and which stored credential opens it. */
export interface ModelConnection {
  /** Absolute base URL of an OpenAI-compatible endpoint. */
  readonly baseUrl: string;
  /** Name in the credential store; the value never appears at this seam. */
  readonly credentialName: string;
}

export interface ModelDescriptor {
  readonly id: string;
  readonly displayName?: string;
}

/** What a probe found: reachability, the models on offer, and stream support. */
export interface ModelProbeResult {
  readonly reachable: boolean;
  readonly models: readonly ModelDescriptor[];
  readonly streaming: boolean;
}

/**
 * One completed tool call an assistant turn requested. `arguments` is the
 * decoded JSON object, not the wire's raw string: adapters own their dialect,
 * and a consumer that had to parse a vendor's argument text would be a second
 * interpretation of the same stream.
 */
export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  /** Which tool call a `tool` message answers; absent for every other role. */
  readonly toolCallId?: string;
  /**
   * An assistant turn's completed tool calls, in the order the model requested
   * them. A `tool` message answers exactly one of these by `toolCallId`, so a
   * history that replays tool use carries both halves; a request that drops the
   * calls leaves the endpoint a result with no parent and is refused rather
   * than guessed at.
   */
  readonly toolCalls?: readonly ModelToolCall[];
}

/**
 * One tool the model may call. `parameters` is a JSON Schema document kept
 * provider-neutral: a vendor that wants another dialect translates it in its
 * adapter, the run never does.
 */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/**
 * What one model turn emits. Deltas stream as they arrive; `tool.requested` is
 * the completed call, after its argument deltas, so a consumer can render
 * progress and act on exactly one event per call.
 */
export type ModelStreamEvent =
  | { readonly type: "text.delta"; readonly delta: string }
  | { readonly type: "tool.delta"; readonly callId: string; readonly argumentsDelta: string }
  | {
      readonly type: "tool.requested";
      readonly callId: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | { readonly type: "completed"; readonly finishReason: "stop" | "tool_calls" | "length" };

export interface ModelTurnRequest {
  readonly connection: ModelConnection;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  /** Cancellation: an aborted turn stops as soon as the transport allows. */
  readonly abortSignal?: AbortSignal;
}

export interface ModelRuntimeProvider {
  /** Ask the endpoint what it offers; a refusal is a classified failure, never a stored hope. */
  probe(connection: ModelConnection): Promise<ModelProbeResult>;
  /**
   * Run one turn and stream its events. The iterable ends after exactly one
   * `completed` event; a failure before then raises `ProviderFailure`, so a
   * consumer cannot mistake a truncated turn for a finished one.
   */
  stream(request: ModelTurnRequest): AsyncIterable<ModelStreamEvent>;
}

export const failureMapping: FailureMapping = {
  gone: "Not produced: a model endpoint has no owned instance to lose; an endpoint that stops answering is `timed_out` or `auth_failed`, and a model id that disappears is `not_found`.",
  not_found:
    "The endpoint or the requested model id does not exist (HTTP 404); the probe reports it instead of failing connection setup blind.",
  rate_limited:
    "The endpoint refuses work under a quota (HTTP 429 or the provider's equivalent signal); the run backs off rather than failing.",
  timed_out:
    "No first token inside the request budget, or a stream that stalls past its idle budget; the turn is over, not paused.",
  auth_failed:
    "The credential is refused (401/403); a credential the store does not hold fails earlier as `CredentialMissingError`.",
};
