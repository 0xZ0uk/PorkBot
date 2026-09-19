import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The model connections module (slice 9.2, PRD decisions 12, 13 and 19; stories
 * 12 and 13).
 *
 * A connection is the generic way to reach a model: an OpenAI-compatible base
 * URL and the *name* of the stored credential that opens it. The contract has
 * no field that can carry the key — the value travels only through
 * `credentials.store`, is encrypted by the store, and is masked in every
 * response — so "a connection response never contains a secret" is a property
 * of the schema rather than a promise about a handler.
 *
 * `modelConnections.probe` is the "real result rather than a stored hope": the
 * router resolves the stored credential and asks the endpoint over the
 * URL-safety transport, and the answer reports reachability, the models on
 * offer and whether the endpoint actually streams. A refusal the probe could
 * classify comes back as data (`failure`), so the settings surface can show
 * "auth failed" or "rate limited" beside the connection instead of an opaque
 * 500; a missing credential or an unreadable store stays the typed error those
 * facts already are.
 */

/**
 * The five provider failure kinds, for the probe's answer. `@porkbot/adapter-kit`
 * owns the vocabulary and this mirrors it for the wire; the suite beside this
 * module fails when the two drift.
 *
 * The computer selection surface answers the same vocabulary (slice 9.4), so
 * `providerFailureKindSchema` is the one wire mirror and this alias keeps the
 * model probe's public name for it.
 */
export const providerFailureKindSchema = z.enum([
  "gone",
  "not_found",
  "rate_limited",
  "timed_out",
  "auth_failed",
]);

export type ProviderFailureKindView = z.infer<typeof providerFailureKindSchema>;

export const modelFailureKindSchema = providerFailureKindSchema;

export type ModelFailureKind = z.infer<typeof modelFailureKindSchema>;

/** One model the endpoint offers. */
export const modelDescriptorSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().optional(),
});

/**
 * What a probe found. `reachable` is true when the connection can serve a
 * turn: discovery answered, the models are what it offered, and the sampled
 * model accepted a streaming request. A discovery that answered while a turn
 * was refused — an auth failure, a model the chat path does not know — is
 * `reachable: false` with the classified `failure`, because the connection is
 * not usable yet. `streaming` is false when the endpoint answered without an
 * event stream, or offered no model to check, so "streaming unsupported" is a
 * result rather than a guess. `failure` is non-null only when the probe was
 * refused and classified.
 */
export const modelProbeSchema = z.object({
  reachable: z.boolean(),
  models: z.array(modelDescriptorSchema),
  streaming: z.boolean(),
  failure: modelFailureKindSchema.nullable(),
});

export type ModelProbe = z.infer<typeof modelProbeSchema>;

/**
 * A connection as every response carries it: the URL and credential *name*,
 * the mask the store derives for that name (null when the store holds no such
 * credential), the connection's default model, whether it is the space's
 * default, and when a request last left for it. There is no field for the
 * credential's value or its ciphertext.
 */
export const modelConnectionSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  baseUrl: z.string(),
  credentialName: z.string(),
  /** Derived by the credential store; never the value. */
  credentialMaskedValue: z.string().nullable(),
  defaultModel: z.string().nullable(),
  isDefault: z.boolean(),
  /**
   * When a request last left for this endpoint — a probe today, a run's model
   * selection when runs select one — or `null` for never. A display fact; the
   * settings list renders it and nothing branches on it.
   */
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ModelConnection = z.infer<typeof modelConnectionSchema>;

/**
 * The base URL shape the provider can actually join a path to: absolute
 * http(s), no embedded credentials, no query string and no fragment. Validation
 * here is the first check, not the trust boundary — the URL-safety module
 * still decides what may be dialed at request time.
 */
export const modelBaseUrlSchema = z
  .string()
  .min(1)
  .max(2_048)
  .refine((value) => {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      return false;
    }

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  }, "Expected an absolute http(s) URL without embedded credentials, a query string or a fragment");

/** The name a provider resolves; the value is stored through `credentials.store`. */
export const credentialNameSchema = z.string().min(1).max(200);

export const modelConnectionsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/model-connections",
    operationId: "modelConnectionsList",
    summary: "The actor's model connections, never a credential value",
  })
  .output(z.object({ connections: z.array(modelConnectionSchema) }));

export const modelConnectionsCreateContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/model-connections",
    operationId: "modelConnectionsCreate",
    summary: "Connect an OpenAI-compatible endpoint by URL and credential name",
  })
  .input(
    z.object({
      label: z.string().min(1).max(200),
      baseUrl: modelBaseUrlSchema,
      credentialName: credentialNameSchema,
      defaultModel: z.string().min(1).max(200).nullable().optional(),
    }),
  )
  .errors({
    /** The label is already used in the actor's space. */
    CONFLICT: {
      status: 409,
      message: "A model connection with that label already exists",
    },
  })
  .output(modelConnectionSchema);

export const modelConnectionsUpdateContract = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/model-connections/{id}",
    operationId: "modelConnectionsUpdate",
    summary: "Edit a model connection's URL, label, credential name or default model",
  })
  .input(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1).max(200).optional(),
      baseUrl: modelBaseUrlSchema.optional(),
      credentialName: credentialNameSchema.optional(),
      /** `null` clears the default model; a bot then needs its own model id. */
      defaultModel: z.string().min(1).max(200).nullable().optional(),
    }),
  )
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such model connection in this space",
    },
    CONFLICT: {
      status: 409,
      message: "A model connection with that label already exists",
    },
  })
  .output(modelConnectionSchema);

export const modelConnectionsSetDefaultContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/model-connections/{id}/default",
    operationId: "modelConnectionsSetDefault",
    summary: "Make exactly this connection the space's default",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such model connection in this space",
    },
  })
  .output(modelConnectionSchema);

export const modelConnectionsRemoveContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/model-connections/{id}",
    operationId: "modelConnectionsRemove",
    summary: "Disconnect a model connection; its stored credential is left in place",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such model connection in this space",
    },
  })
  .output(modelConnectionSchema);

/**
 * The probe's outcome. A classified provider refusal is `probe.failure`; a
 * credential the store does not hold is the typed `PRECONDITION_FAILED` and an
 * unreadable store the typed `SERVICE_UNAVAILABLE`, because only the operator
 * can repair either.
 */
export const modelConnectionsProbeContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/model-connections/{id}/probe",
    operationId: "modelConnectionsProbe",
    summary: "Probe a stored connection and report reachability, models and streaming",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such model connection in this space",
    },
    PRECONDITION_FAILED: {
      status: 412,
      message: "Store the connection's credential before probing it",
    },
    SERVICE_UNAVAILABLE: {
      status: 503,
      message: "The credential store is not readable",
    },
  })
  .output(z.object({ connectionId: z.string().min(1), probe: modelProbeSchema }));
