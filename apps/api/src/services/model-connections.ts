import type { CredentialStore, ModelRuntimeProvider } from "@porkbot/adapter-kit";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ModelConnection, ModelProbe } from "@porkbot/contracts";
import type {
  ModelConnectionPatch,
  ModelConnectionRecord,
  NewModelConnection,
  UserRepositories,
} from "@porkbot/db";
import type { CredentialSummary } from "@porkbot/effect";

/**
 * The model connections service (slice 9.2, PRD decisions 12, 13 and 19).
 *
 * It owns the two pieces of logic a router may not: presenting a connection
 * with the credential store's mask, and turning a classified provider refusal
 * into the probe's data. Everything else delegates to the actor-scoped
 * repositories, so the router stays a transport projection and the gate stays
 * the one boundary that maps errors.
 *
 * The probe resolves the credential through `CredentialStore.resolve` inside
 * the provider; the mask shown on the connection is derived by the store's own
 * `list`, never by reading the value here. There is no branch that returns a
 * secret: `resolve` is the provider's half and no response field carries it.
 */

export interface ModelConnectionsServiceOptions {
  /**
   * Builds the provider for one request over the actor's credential store. The
   * composition root supplies the shipped OpenAI-compatible implementation; a
   * test supplies one over the offline emulator, so the suite crosses a real
   * wire with no network and no key.
   */
  readonly runtime: (credentials: CredentialStore) => ModelRuntimeProvider;
}

export interface ModelConnectionsService {
  list(repositories: UserRepositories): Promise<{ readonly connections: ModelConnection[] }>;
  create(repositories: UserRepositories, input: NewModelConnection): Promise<ModelConnection>;
  update(
    repositories: UserRepositories,
    id: string,
    patch: ModelConnectionPatch,
  ): Promise<ModelConnection>;
  setDefault(repositories: UserRepositories, id: string): Promise<ModelConnection>;
  remove(repositories: UserRepositories, id: string): Promise<ModelConnection>;
  /** The live probe: reachability, models and streaming, or the classified refusal. */
  probe(
    repositories: UserRepositories,
    id: string,
  ): Promise<{ readonly connectionId: string; readonly probe: ModelProbe }>;
}

export function createModelConnectionsService(
  options: ModelConnectionsServiceOptions,
): ModelConnectionsService {
  async function present(
    repositories: UserRepositories,
    record: ModelConnectionRecord,
  ): Promise<ModelConnection> {
    const summaries = await repositories.credentials.list();
    const mask = summaries.find((summary) => summary.name === record.credentialName);

    return view(record, mask?.maskedValue ?? null);
  }

  return {
    async list(repositories) {
      const records = await repositories.modelConnections.list();
      const masks = masksByName(await repositories.credentials.list());

      return {
        connections: records.map((record) =>
          view(record, masks.get(record.credentialName) ?? null),
        ),
      };
    },

    async create(repositories, input) {
      return present(repositories, await repositories.modelConnections.create(input));
    },

    async update(repositories, id, patch) {
      return present(repositories, await repositories.modelConnections.update(id, patch));
    },

    async setDefault(repositories, id) {
      return present(repositories, await repositories.modelConnections.setDefault(id));
    },

    async remove(repositories, id) {
      return present(repositories, await repositories.modelConnections.delete(id));
    },

    async probe(repositories, id) {
      const connection = await repositories.modelConnections.findById(id);
      const runtime = options.runtime(repositories.credentials);

      try {
        const result = await runtime.probe({
          baseUrl: connection.baseUrl,
          credentialName: connection.credentialName,
        });

        return {
          connectionId: connection.id,
          probe: {
            reachable: result.reachable,
            models: result.models.map((model) =>
              model.displayName === undefined
                ? { id: model.id }
                : { id: model.id, displayName: model.displayName },
            ),
            streaming: result.streaming,
            failure: null,
          },
        };
      } catch (error) {
        // A refusal the provider classified is the answer, not a defect: the
        // settings surface shows which kind beside the connection. Everything
        // else — a missing credential, an unreadable store, a bug — travels to
        // the gate's mapping, the one place that decides a status.
        if (isProviderFailure(error)) {
          return {
            connectionId: connection.id,
            probe: { reachable: false, models: [], streaming: false, failure: error.kind },
          };
        }

        throw error;
      }
    },
  };
}

function masksByName(summaries: readonly CredentialSummary[]): Map<string, string> {
  return new Map(summaries.map((summary) => [summary.name, summary.maskedValue]));
}

function view(
  record: ModelConnectionRecord,
  credentialMaskedValue: string | null,
): ModelConnection {
  return {
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    credentialName: record.credentialName,
    credentialMaskedValue,
    defaultModel: record.defaultModel,
    isDefault: record.isDefault,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
