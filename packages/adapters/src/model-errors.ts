import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/** A model endpoint refusal translated into the shared lifecycle vocabulary. */
export class ModelProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`Model runtime failed (${kind}): ${detail}`, options);
    this.name = "ModelProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}
