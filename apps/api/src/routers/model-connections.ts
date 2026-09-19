import { authenticated } from "../gate.ts";
import type { ModelConnectionsService } from "../services/model-connections.ts";

/**
 * The model connections router (slice 9.2, PRD decisions 12, 13 and 19; stories
 * 12 and 13).
 *
 * Every handler works through the actor-scoped repositories via the service,
 * so a connection id from another space and an id that does not exist answer
 * the same typed `NOT_FOUND`, and nothing can name a space. The response view
 * carries the credential's *name* and the mask the credential store derives
 * for it; there is no field that could carry the value, because the value is
 * never read out of the store by anything here.
 *
 * The probe's classified refusals are the service's business; this router
 * projects inputs and outputs and lets the gate map every error, exactly as
 * every other router does.
 */
export function createModelConnectionsRouter(service: ModelConnectionsService) {
  const list = authenticated.modelConnections.list.handler(async ({ context }) =>
    service.list(context.repositories),
  );

  const create = authenticated.modelConnections.create.handler(async ({ input, context }) =>
    service.create(context.repositories, input),
  );

  const update = authenticated.modelConnections.update.handler(async ({ input, context }) =>
    service.update(context.repositories, input.id, {
      label: input.label,
      baseUrl: input.baseUrl,
      credentialName: input.credentialName,
      defaultModel: input.defaultModel,
    }),
  );

  const setDefault = authenticated.modelConnections.setDefault.handler(async ({ input, context }) =>
    service.setDefault(context.repositories, input.id),
  );

  const remove = authenticated.modelConnections.remove.handler(async ({ input, context }) =>
    service.remove(context.repositories, input.id),
  );

  const probe = authenticated.modelConnections.probe.handler(async ({ input, context }) =>
    service.probe(context.repositories, input.id),
  );

  return authenticated.modelConnections.router({
    list,
    create,
    update,
    setDefault,
    remove,
    probe,
  });
}
