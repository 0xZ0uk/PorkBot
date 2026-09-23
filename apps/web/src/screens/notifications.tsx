import { Button, Field, Input } from "@porkbot/ui";
import type { NotificationKind } from "@porkbot/core";
import { notificationLabel } from "../notifications.ts";
import type { NotificationsState } from "../notifications.ts";
import { NotificationsSkeleton } from "./loading.tsx";

/**
 * The notification switches (slice 11.5, story 35): one row per event kind,
 * on when the operator said so and off by default.
 *
 * Every kind the contract carries renders, whether or not a row is stored for
 * it, because the set arrives with the defaults filled in; the copy names the
 * event, and the one sentence above the list explains why everything is off
 * until it is turned on. A write in flight disables exactly its own switch;
 * the others stay usable.
 */

export interface NotificationsScreenProps {
  readonly state: NotificationsState;
  readonly onToggle: (kind: NotificationKind, enabled: boolean) => void;
  readonly onReload: () => void;
}

export function NotificationsScreen({ state, onToggle, onReload }: NotificationsScreenProps) {
  if (state.status === "refused") {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {state.refusal}
        </p>
        <Button onClick={onReload}>Try again</Button>
      </section>
    );
  }

  if (state.status === "loading") {
    return <NotificationsSkeleton />;
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <h2>Notifications</h2>
      <p className="text-muted-foreground">Nothing interrupts you until you turn it on.</p>

      {state.notice === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {state.notice}
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {state.preferences.map((preference) => (
          <li key={preference.kind} className="flex items-center gap-2">
            <Field label={notificationLabel(preference.kind)}>
              <Input
                type="checkbox"
                checked={preference.enabled}
                disabled={state.pending === preference.kind}
                onChange={(event) => {
                  onToggle(preference.kind, event.target.checked);
                }}
              />
            </Field>
          </li>
        ))}
      </ul>
    </section>
  );
}
