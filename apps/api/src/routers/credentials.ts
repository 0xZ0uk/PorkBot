import type { CredentialSummary } from "@porkbot/effect";
import { authenticated } from "../gate.ts";

/**
 * The stored credentials router: the operator's masked list. The handler
 * receives the actor-scoped repositories, so the store it reads through is
 * bound to the session's space and the input names nothing; a caller can only
 * ever see its own space's credentials.
 *
 * The response is a projection of the store's summaries — id, name, mask and
 * timestamps — with dates as ISO strings. There is no branch that could return
 * a value: the value never leaves the store except through `resolve`, which no
 * procedure calls.
 */
export function createCredentialsRouter() {
  const list = authenticated.credentials.list.handler(async ({ context }) => {
    return { credentials: (await context.repositories.credentials.list()).map(toView) };
  });

  return authenticated.credentials.router({ list });
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
