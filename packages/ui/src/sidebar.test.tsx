// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { click, renderDom } from "./dom-test.helper.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "./sidebar.tsx";

function Probe({ label }: { readonly label: string }) {
  const { state, toggleSidebar } = useSidebar();

  return (
    <button type="button" data-label={label} onClick={toggleSidebar}>
      {`${label}:${state}`}
    </button>
  );
}

describe("Sidebar", () => {
  it("collapses and expands from its trigger", async () => {
    const { container, unmount } = await renderDom(
      <SidebarProvider storageKey="rail">
        <Probe label="rail" />
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Routines</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );

    expect(container.textContent).toContain("rail:expanded");
    await click(container.querySelector('button[data-label="rail"]') as Element);
    expect(container.textContent).toContain("rail:collapsed");
    await click(container.querySelector('button[data-label="rail"]') as Element);
    expect(container.textContent).toContain("rail:expanded");
    await unmount();
  });

  it("renders a menu item as a button in a list", async () => {
    const { container, unmount } = await renderDom(
      <SidebarProvider storageKey="rail">
        <Sidebar>
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive>Routines</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
      </SidebarProvider>,
    );

    expect(container.querySelector("ul")).not.toBeNull();
    expect(container.querySelector("li button")?.textContent).toBe("Routines");
    await unmount();
  });

  it("holds two providers in independent state", async () => {
    // The shell mounts a second sidebar for the inspector under its own
    // provider, so collapsing the rail must not collapse the inspector.
    const { container, unmount } = await renderDom(
      <>
        <SidebarProvider storageKey="rail">
          <Probe label="rail" />
          <Sidebar side="left">
            <SidebarContent>Rail</SidebarContent>
          </Sidebar>
        </SidebarProvider>
        <SidebarProvider storageKey="inspector" defaultOpen>
          <Probe label="inspector" />
          <Sidebar side="right">
            <SidebarContent>Inspector</SidebarContent>
          </Sidebar>
        </SidebarProvider>
      </>,
    );

    expect(container.textContent).toContain("rail:expanded");
    expect(container.textContent).toContain("inspector:expanded");

    await click(container.querySelector('button[data-label="rail"]') as Element);

    expect(container.textContent).toContain("rail:collapsed");
    expect(container.textContent).toContain("inspector:expanded");

    await click(container.querySelector('button[data-label="inspector"]') as Element);

    expect(container.textContent).toContain("rail:collapsed");
    expect(container.textContent).toContain("inspector:collapsed");
    await unmount();
  });
});
