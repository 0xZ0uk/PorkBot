import { Button, Card, Field, Input } from "@porkbot/ui";
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Registration } from "../session.ts";

export interface SignUpScreenProps {
  readonly error: string | null;
  readonly onSubmit: (registration: Registration) => Promise<void>;
  /** Router-aware links, composed by the route so the screen stays testable. */
  readonly footer?: ReactNode;
}

/**
 * The registration screen. It is reachable only when the deployment's public
 * status says signups are open; the server still decides — this screen sends
 * the intent and renders the refusal the gate answers with.
 */
export function SignUpScreen({ error, onSubmit, footer }: SignUpScreenProps) {
  const [name, setName] = useState("");
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
      await onSubmit({ name, email, password });
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
        <h1>Create account</h1>
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
        <Field label="Name" htmlFor="sign-up-name">
          <Input
            id="sign-up-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Email" htmlFor="sign-up-email">
          <Input
            id="sign-up-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="sign-up-password">
          <Input
            id="sign-up-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            aria-describedby={error !== null ? errorId : undefined}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
        {footer}
      </Card>
    </main>
  );
}
