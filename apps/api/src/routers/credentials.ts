import type { CredentialSummary } from "@porkbot/effect";
import { authenticated } from "../gate.ts";

/**
 * The stored credentials router: the operator's masked list and the write
 * that stores a value. The handler receives the actor-scoped repositories, so
 * the store it reads and writes through is bound to the session's space and
 * the input names nothing; a caller can only ever touch its own space's
 * credentials.
 *
 * The response is a projection of the store's summaries — id, name, mask and
 * timestamps — with dates as ISO strings. There is no branch that could return
 * a value: the value is encrypted by the store on the way in, and it never
 * leaves the store except through `resolve`, which no procedure calls. The one
 * place a value exists is the write's request body, which is bounded by the
 * schema and the body cap before it reaches the store.
 *
 * `remove` is the revoke: a scoped delete by name that takes effect on the next
 * resolve and answers the name it was addressed by. It reads and writes no
 * value, so it works even when the keyring cannot unlock the store — an
 * operator revoking after a key loss is exactly the case it must serve.
 */
export function createCredentialsRouter() {
  const list = authenticated.credentials.list.handler(async ({ context }) => {
    return { credentials: (await context.repositories.credentials.list()).map(toView) };
  });

  const store = authenticated.credentials.store.handler(async ({ input, context }) =>
    toView(await context.repositories.credentials.store(input.name, input.value)),
  );

  const remove = authenticated.credentials.remove.handler(async ({ input, context }) => {
    await context.repositories.credentials.remove(input.name);

    return { name: input.name };
  });

  return authenticated.credentials.router({ list, store, remove });
}

function toView(summary: CredentialSummary) {
  return {
    id: summary.id,
    name: summary.name,
    maskedValue: summary.maskedValue,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}
