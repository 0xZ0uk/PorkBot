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
 * promise about a handler. Writing and revoking credentials are slices 9.2 and
 * 9.3; they add procedures here, not a second source of the mask.
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
