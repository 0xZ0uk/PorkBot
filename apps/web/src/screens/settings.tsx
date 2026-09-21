import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ModeControl } from "../shell/mode-control.tsx";

/**
 * The settings surface (slice 13.13): one panel, six sections, a sticky section
 * nav and the explicit mode control.
 *
 * The old index was a directory of six link cards, so every value sat one
 * navigation deeper than the question that asked for it. Here each section
 * renders its own current values inline, the nav moves within the panel rather
 * than out of it, and the mode control — System, Light, Dark — sits in the
 * panel's head where the choice is visible without scrolling to it.
 *
 * The nav highlights the section in view: the sections are observed and the
 * link whose section owns the reading band is marked `aria-current`. A click
 * marks its link immediately and the anchor does the scroll, so the nav still
 * works where an observer does not exist.
 */

export interface SettingsSection {
  /** The anchor target and the observer's key; unique within the panel. */
  readonly id: string;
  readonly label: string;
  readonly content: ReactNode;
}

export interface SettingsScreenProps {
  readonly sections: readonly SettingsSection[];
}

export function SettingsScreen({ sections }: SettingsScreenProps) {
  const rootRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(sections[0]?.id ?? "");
  const count = sections.length;
  const first = sections[0]?.id ?? "";
  const last = sections[count - 1]?.id ?? "";

  useEffect(() => {
    const root = rootRef.current;
    // The pane is the scroll container; without it the nav keeps the marks a
    // click or a scroll left rather than guessing from nothing.
    const pane = root?.closest(".shell-pane") ?? null;

    if (root === null || pane === null) {
      return;
    }

    // The section crossing the reading band is the one the operator is on:
    // the band's edge is fixed to the pane, not to the viewport, because the
    // pane is what scrolls. Reaching the pane's end marks the last section,
    // which a short section below the band could never otherwise claim.
    function markFromScroll(): void {
      // An unlaid-out pane (a document before first layout) has no reading
      // band to mark from; a click still marks, and the observer's first
      // report re-marks once the layout exists.
      if (pane === null || pane.clientHeight === 0) {
        return;
      }

      if (
        pane.scrollHeight > pane.clientHeight + 2 &&
        pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
      ) {
        setActive(last);

        return;
      }

      const threshold = pane.getBoundingClientRect().top + pane.clientHeight * 0.24;
      let current = first;

      for (const element of root?.querySelectorAll("[data-settings-section]") ?? []) {
        if (element.getBoundingClientRect().top <= threshold) {
          const id = element.getAttribute("data-settings-section");

          if (id !== null) {
            current = id;
          }
        }
      }

      setActive(current);
    }

    // A section's reads land after the first paint and grow its box, so the
    // observer re-marks when the layout moves even though no scroll happened;
    // the pane itself is watched too, because a resize moves the band.
    const sectionsRoot = root.querySelector(".settings-sections");
    const resize =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(markFromScroll);

    resize?.observe(sectionsRoot ?? root);
    resize?.observe(pane);
    pane.addEventListener("scroll", markFromScroll, { passive: true });
    markFromScroll();

    return () => {
      resize?.disconnect();
      pane.removeEventListener("scroll", markFromScroll);
    };
  }, [count, first, last]);

  // A hash is how an old per-section path and an in-panel anchor both say
  // which section to show, so the section it names is marked and scrolled to
  // on load and on every hash change, including back and forward.
  useEffect(() => {
    const root = rootRef.current;

    if (root === null || typeof globalThis.location === "undefined") {
      return;
    }

    function markFromHash(): void {
      const id = globalThis.location.hash.replace(/^#/, "");
      const element =
        id === ""
          ? undefined
          : [...(root?.querySelectorAll<HTMLElement>("[data-settings-section]") ?? [])].find(
              (candidate) => candidate.id === id,
            );

      if (element === undefined) {
        return;
      }

      setActive(id);
      element.scrollIntoView?.({ block: "start" });
    }

    markFromHash();
    globalThis.addEventListener("hashchange", markFromHash);

    return () => {
      globalThis.removeEventListener("hashchange", markFromHash);
    };
  }, [count]);

  return (
    <section className="settings" aria-labelledby="settings-title" ref={rootRef}>
      <header className="settings-head">
        <h1 className="settings-title" id="settings-title">
          Settings
        </h1>
        <ModeControl />
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map((section) => (
            <a
              key={section.id}
              className="settings-nav-link"
              href={`#${section.id}`}
              aria-current={active === section.id ? "true" : undefined}
              onClick={() => {
                setActive(section.id);
              }}
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="settings-sections">
          {sections.map((section) => (
            <div
              key={section.id}
              className="settings-section"
              id={section.id}
              data-settings-section={section.id}
            >
              {section.content}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
