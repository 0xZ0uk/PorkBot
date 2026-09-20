import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { SecretsScreen } from "../../screens/secrets.tsx";
import { useSecrets } from "../../use-secrets.ts";
import type { SecretsTransport } from "../../secrets.ts";

/**
 * The secrets settings route. The loader fails closed when the process was
 * composed without the transport; the section below is a function of the
 * controller's state, and a store or a forget re-reads the selected bot
 * through the same transport.
 */
export const Route = createFileRoute("/_app/settings/secrets")({
  loader: ({ context }) => {
    if (context.secrets === undefined) {
      throw new Error("the secrets transport is not configured");
    }
  },
  component: SecretsRoute,
  errorComponent: SecretsUnavailable,
});

function SecretsRoute() {
  const { secrets } = Route.useRouteContext();

  if (secrets === undefined) {
    return <SecretsUnavailable reset={() => undefined} />;
  }

  return <SecretsSection transport={secrets} />;
}

function SecretsSection({ transport }: { readonly transport: SecretsTransport }) {
  const { state, load, selectBot, store, forget } = useSecrets({ transport });

  return (
    <SecretsScreen
      state={state}
      onReload={load}
      onSelectBot={(botId) => {
        void selectBot(botId);
      }}
      onStore={store}
      onForget={forget}
    />
  );
}

function SecretsUnavailable({ reset }: { readonly reset: () => void }) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        Secrets could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
