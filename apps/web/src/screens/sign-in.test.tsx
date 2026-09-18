// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authErrorMessage } from "../refusal.ts";
import { AuthRefusal } from "../session.ts";
import { SignInScreen } from "./sign-in.tsx";

/**
 * The sign-in screen, in a real DOM: every label is bound to its input, the
 * tab order follows the document, and a refusal moves focus to the alert so a
 * keyboard or screen-reader user is told what happened.
 *
 * The slot a route fills with a router `Link` is a plain anchor here, which is
 * the same element the router renders and keeps this test free of a router.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const footer = <a href="/sign-up">Create an account</a>;

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

function input(selector: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(selector);

  if (element === null) {
    throw new Error(`the input ${selector} is missing`);
  }

  return element;
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

async function setValue(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  if (setter === undefined) {
    throw new Error("the input value setter is missing");
  }

  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the sign-in form", () => {
  it("binds every label to its input", async () => {
    await render(<SignInScreen error={null} signup="open" onSubmit={vi.fn()} footer={footer} />);

    const email = container.querySelector<HTMLLabelElement>("label[for='sign-in-email']");
    const password = container.querySelector<HTMLLabelElement>("label[for='sign-in-password']");

    expect(email?.textContent).toBe("Email");
    expect(password?.textContent).toBe("Password");
    expect(container.querySelector("#sign-in-email")?.getAttribute("autocomplete")).toBe("email");
    expect(container.querySelector("#sign-in-password")?.getAttribute("type")).toBe("password");
  });

  it("keeps the keyboard order labels, fields, submit, then the footer link", async () => {
    await render(<SignInScreen error={null} signup="open" onSubmit={vi.fn()} footer={footer} />);

    const focusable = [...container.querySelectorAll<HTMLElement>("input, button, a[href]")].filter(
      (element) => !element.hasAttribute("disabled"),
    );

    expect(focusable.map((element) => element.id || element.textContent)).toEqual([
      "sign-in-email",
      "sign-in-password",
      "Sign in",
      "Create an account",
    ]);

    for (const element of focusable) {
      element.focus();
      expect(document.activeElement).toBe(element);
    }
  });

  it("hides the registration link unless signups are open", async () => {
    await render(<SignInScreen error={null} signup="closed" onSubmit={vi.fn()} footer={footer} />);

    expect(container.querySelector("a[href='/sign-up']")).toBeNull();
  });

  it("submits the typed credentials", async () => {
    const onSubmit = vi.fn(async () => undefined);
    await render(<SignInScreen error={null} signup="open" onSubmit={onSubmit} footer={footer} />);

    await setValue(input("#sign-in-email"), "operator@example.invalid");
    await setValue(input("#sign-in-password"), "correct-horse");

    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(onSubmit).toHaveBeenCalledWith({
      email: "operator@example.invalid",
      password: "correct-horse",
    });
  });

  it("focuses the alert when a refusal arrives", async () => {
    await render(<SignInScreen error={null} signup="open" onSubmit={vi.fn()} footer={footer} />);
    await render(
      <SignInScreen
        error={authErrorMessage(new AuthRefusal("refused", "Invalid email or password."))}
        signup="open"
        onSubmit={vi.fn()}
        footer={footer}
      />,
    );

    const alert = container.querySelector<HTMLElement>("[role='alert']");

    expect(alert?.textContent).toBe("Invalid email or password.");
    expect(document.activeElement).toBe(alert);
  });

  it("disables the submit while the attempt is in flight", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onSubmit = vi.fn(() => pending);
    await render(<SignInScreen error={null} signup="open" onSubmit={onSubmit} footer={footer} />);

    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const submit = container.querySelector<HTMLButtonElement>("button[type='submit']");

    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toBe("Signing in…");

    await act(async () => {
      release();
    });

    expect(submit?.disabled).toBe(false);
  });
});
