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
    expect(html).toContain("Name");
  });

  it("renders a hint and an announced error", () => {
    const html = renderToStaticMarkup(
      <Field label="Name" hint="Up to 64 characters" error="Name is required">
        <Input />
      </Field>,
    );
    expect(html).toContain("Up to 64 characters");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Name is required");
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
    expect(html).toContain('value="a"');
    expect(html).toContain("<option");
  });

  it("keeps the control focusable and typed", async () => {
    const { container, unmount } = await renderDom(
      <Field label="Name">
        <Input type="text" defaultValue="Ada" />
      </Field>,
    );
    const input = container.querySelector("input");
    expect(input?.getAttribute("type")).toBe("text");
    expect(input?.value).toBe("Ada");
    await unmount();
  });
});
