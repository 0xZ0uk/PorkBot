import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The stored credentials module (slice 9.1, PRD decision 10; stories 14 and 15).
 *
 * A credential is a named secret a provider resolves — a model key, a webhook's
 * signing secret — encrypted at rest and never returned. This module is the
 * read surface the operator's settings screen grows from: `credentials.list`
 * answers every stored credential in the actor's space as a masked summary, so
 * the response can say what is connected without ever carrying the value.
 *
 * There is deliberately no field for the value, its ciphertext or its
 * fingerprint: the contract's output is the whole transport surface, so "a list
 * endpoint never returns a secret" is a property of the schema rather than a
 * promise about a handler. `credentials.store` (slice 9.2) is the write half —
 * the value is an input, the output is only the mask the store derives — and
 * revoking a credential is slice 9.3; they add procedures here, not a second
 * source of the mask.
 */

export const credentialSchema = z.object({
  id: z.string().min(1),
  /** The name a provider resolves, e.g. `model-key`. */
  name: z.string(),
  /**
   * A display-only mask such as `••••4f2a`, derived from the value by the
   * store. The value itself is not a field and cannot be returned.
   */
  maskedValue: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Credential = z.infer<typeof credentialSchema>;

export const credentialsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/credentials",
    operationId: "credentialsList",
    summary: "Stored credentials for this operator, masked",
  })
  .errors({
    /**
     * The keyring cannot unlock a row: a key a ciphertext names is absent, or
     * the envelope failed authentication. Only the operator can repair it, and
     * the client message deliberately says no more than that.
     */
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The credential store is not readable",
    },
  })
  .output(z.object({ credentials: z.array(credentialSchema) }));

export const credentialsStoreContract = authenticatedProcedure
  .route({
    method: "PUT",
    path: "/credentials/{name}",
    operationId: "credentialsStore",
    summary: "Store or replace a named credential, encrypted at rest",
  })
  .input(
    z.object({
      /** The name a provider resolves, e.g. `model-key`. */
      name: z.string().min(1).max(200),
      /**
       * The secret. The request body cap bounds it before it is parsed; this
       * bound is the schema's own, large enough for a long key or a small PEM
       * and small enough that a mistake is refused rather than stored.
       */
      value: z.string().min(1).max(16_384),
    }),
  )
  .errors({
    /** The keyring cannot unlock the store; only the operator can repair it. */
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The credential store is not readable",
    },
  })
  .output(credentialSchema);
