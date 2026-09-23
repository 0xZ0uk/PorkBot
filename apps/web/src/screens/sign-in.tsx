import { Button, Card, Field, Input } from "@porkbot/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Credentials, SignupAvailability } from "../session.ts";

export interface SignInScreenProps {
  /** The sentence to show after a refused attempt, or `null` for no error. */
  readonly error: string | null;
  /** Whether the deployment offers registration; the offer is hidden unless open. */
  readonly signup: SignupAvailability;
  readonly onSubmit: (credentials: Credentials) => Promise<void>;
  /** Router-aware links, composed by the route so the screen stays testable. */
  readonly footer?: ReactNode;
}

/**
 * The sign-in screen: one form, labels bound to inputs, and an error region
 * that takes focus when a refusal arrives so a keyboard or screen-reader user
 * hears it instead of hunting for it.
 */
export function SignInScreen({ error, signup, onSubmit, footer }: SignInScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (error !== null) {
      errorRef.current?.focus();
    }
  }, [error]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (pending) {
      return;
    }

    setPending(true);

    try {
      await onSubmit({ email, password });
    } finally {
      setPending(false);
    }
  }

  return (
    <main
      id="main"
      className="flex min-h-full flex-col items-center justify-center gap-4 p-4"
      tabIndex={-1}
    >
      <Card as="form" className="w-full max-w-sm" onSubmit={handleSubmit} aria-busy={pending}>
        <h1>Sign in</h1>
        {error !== null && (
          <p
            id={errorId}
            className="rounded-md border border-destructive bg-card p-2 text-foreground"
            role="alert"
            tabIndex={-1}
            ref={errorRef}
          >
            {error}
          </p>
        )}
        <Field label="Email" htmlFor="sign-in-email">
          <Input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="sign-in-password">
          <Input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        {signup === "open" && footer}
      </Card>
    </main>
  );
}
