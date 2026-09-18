import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The typed failure a computer provider raises (slice 6.9).
 *
 * Every provider maps its own errors onto the shared vocabulary inside its
 * adapter — `gone` for a machine the provider no longer holds, `not_found` for
 * a path or snapshot inside a running one, `timed_out` for a command that
 * outran the caller's budget — so lifecycle code branches on the kind and never
 * reads a provider message (PRD decision 19). The detail text is written to be
 * operator-safe: it names a state or a destination, never a command's output,
 * a credential or a host path outside the emulated machine.
 */
export class ComputerProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`Computer provider failed (${kind}): ${detail}`, options);
    this.name = "ComputerProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}
