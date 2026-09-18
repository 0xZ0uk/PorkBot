import type { CredentialStore } from "@porkbot/adapter-kit";

/**
 * The two credential stores that ship with the adapters.
 *
 * Neither is the destination. Slice 9.1 adds the encrypted credential table
 * behind this same interface; these two keep that from being a blocker today:
 *
 *   - `createEnvironmentCredentialStore` is the single-process bootstrap. It is
 *     the only place this package reads the environment, and the operator chooses
 *     the variable name, so no provider-specific env var exists (PRD provider
 *     neutrality). A variable that is set but blank is treated as absent — an
 *     empty key must fail closed, not authenticate as an empty string — and
 *     surrounding whitespace is trimmed.
 *   - `createMemoryCredentialStore` is the test and emulator store. It is also
 *     the shape a UI-backed store grows from: set, resolve, delete.
 *
 * Both resolve asynchronously because the interface is the same one a database
 * read implements; a caller cannot tell which store it holds.
 */

export interface MemoryCredentialStore extends CredentialStore {
  set(name: string, value: string): void;
  delete(name: string): boolean;
}

export function createMemoryCredentialStore(
  entries: Iterable<readonly [string, string]> = [],
): MemoryCredentialStore {
  const secrets = new Map<string, string>(entries);

  return {
    resolve(name) {
      return Promise.resolve(secrets.get(name));
    },
    set(name, value) {
      secrets.set(name, value);
    },
    delete(name) {
      return secrets.delete(name);
    },
  };
}

export function createEnvironmentCredentialStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialStore {
  return {
    resolve(name) {
      const value = env[name];

      if (value === undefined || value.trim() === "") {
        return Promise.resolve(undefined);
      }

      return Promise.resolve(value.trim());
    },
  };
}
