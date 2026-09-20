import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { NotificationsScreen } from "../../screens/notifications.tsx";
import { useNotifications } from "../../use-notifications.ts";
import type { NotificationsTransport } from "../../notifications.ts";

/**
 * The notification settings route. The loader fails closed when the process
 * was composed without the transport, and the section below is a function of
 * the controller's state; a toggle writes through the transport and the
 * server's whole set is what renders next.
 */
export const Route = createFileRoute("/_app/settings/notifications")({
  loader: ({ context }) => {
    if (context.notifications === undefined) {
      throw new Error("the notification transport is not configured");
    }
  },
  component: NotificationsRoute,
  errorComponent: NotificationsUnavailable,
});

function NotificationsRoute() {
  const { notifications } = Route.useRouteContext();

  if (notifications === undefined) {
    return <NotificationsUnavailable reset={() => undefined} />;
  }

  return <NotificationsSection transport={notifications} />;
}

function NotificationsSection({ transport }: { readonly transport: NotificationsTransport }) {
  const { state, load, setPreference } = useNotifications({ transport });

  return (
    <NotificationsScreen
      state={state}
      onReload={load}
      onToggle={(kind, enabled) => {
        void setPreference(kind, enabled);
      }}
    />
  );
}

function NotificationsUnavailable({ reset }: { readonly reset: () => void }) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        Notification settings could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
