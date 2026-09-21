// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderDom } from "./dom-test.helper.tsx";
import { Field, Input, Select, Textarea } from "./field.tsx";

describe("Field", () => {
  it("associates its label with the nested control", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" htmlFor="bot-name">
        <Input id="bot-name" />
      </Field>,
    );
    expect(html).toContain('for="bot-name"');
    expect(html).toContain('id="bot-name"');
    expect(html).toContain("pb-field__label");
  });

  it("renders a hint and an announced error", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" hint="Up to 64 characters" error="Name is required">
        <Input />
      </Field>,
    );
    expect(html).toContain("pb-field__hint");
    expect(html).toContain("Up to 64 characters");
    expect(html).toContain("pb-field__error");
    expect(html).toContain('role="alert"');
  });

  it("draws no colour literal", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" error="Required">
        <Input invalid />
      </Field>,
    );
    expect(html).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(|oklch\(/i);
  });
});

describe("the field controls", () => {
  it("marks invalid controls for assistive technology", () => {
    const html = renderToStaticMarkup(<Input invalid />);
    expect(html).toContain('aria-invalid="true"');
  });

  it("carries the disabled state on each control", () => {
    expect(renderToStaticMarkup(<Input disabled />)).toContain("disabled");
    expect(renderToStaticMarkup(<Textarea disabled />)).toContain("disabled");
    expect(renderToStaticMarkup(<Select disabled />)).toContain("disabled");
  });

  it("passes native attributes through", () => {
    const html = renderToStaticMarkup(
      <Select value="a" disabled>
        <option value="a">A</option>
      </Select>,
    );
    expect(html).toContain("pb-select");
    expect(html).toContain("<option");
  });

  it("keeps a ref for the one caller that opens a file chooser", async () => {
    const ref = { current: null as HTMLInputElement | null };
    const { unmount } = await renderDom(<Input ref={ref} type="file" />);
    expect(ref.current?.type).toBe("file");
    await unmount();
  });
});
