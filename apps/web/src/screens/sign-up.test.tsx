// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignUpScreen } from "./sign-up.tsx";

/**
 * The registration screen, in a real DOM: labels bound, autocomplete set to
 * the creation flow rather than the sign-in flow, and the same focus and
 * disable behaviour as sign-in.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

describe("the sign-up form", () => {
  it("binds every label to its input", async () => {
    await render(<SignUpScreen error={null} onSubmit={vi.fn()} />);

    expect(container.querySelector("label[for='sign-up-name']")?.textContent).toBe("Name");
    expect(container.querySelector("label[for='sign-up-email']")?.textContent).toBe("Email");
    expect(container.querySelector("label[for='sign-up-password']")?.textContent).toBe("Password");
    expect(container.querySelector("#sign-up-password")?.getAttribute("autocomplete")).toBe(
      "new-password",
    );
  });

  it("keeps the keyboard order fields, submit, then the footer link", async () => {
    await render(
      <SignUpScreen
        error={null}
        onSubmit={vi.fn()}
        footer={<a href="/sign-in">Sign in instead</a>}
      />,
    );

    const focusable = [...container.querySelectorAll<HTMLElement>("input, button, a[href]")].filter(
      (element) => !element.hasAttribute("disabled"),
    );

    expect(focusable.map((element) => element.id || element.textContent)).toEqual([
      "sign-up-name",
      "sign-up-email",
      "sign-up-password",
      "Create account",
      "Sign in instead",
    ]);
  });

  it("focuses the alert a refusal produces", async () => {
    await render(
      <SignUpScreen error="Signups are closed on this deployment." onSubmit={vi.fn()} />,
    );

    const alert = container.querySelector<HTMLElement>("[role='alert']");

    expect(alert?.textContent).toBe("Signups are closed on this deployment.");
    expect(document.activeElement).toBe(alert);
  });
});
