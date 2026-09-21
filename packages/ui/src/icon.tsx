import type { SVGProps } from "react";

/**
 * The one icon set (design record, Anti-goals: no emoji as interface icons).
 *
 * The glyphs are drawn here rather than taken from a package: a 24-unit grid,
 * a single stroke weight and `currentColor` mean an icon cannot carry a colour
 * of its own, and a surface names a glyph instead of pasting a platform emoji.
 * A glyph the register does not have is added here, in one file a reviewer can
 * see, rather than at the screen that wanted it.
 */

export type IconName =
  | "alert"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "close"
  | "download"
  | "external"
  | "folder"
  | "info"
  | "log-out"
  | "monitor"
  | "more"
  | "panel-left"
  | "plus"
  | "search"
  | "send"
  | "settings"
  | "stop"
  | "terminal"
  | "trash";

const iconPaths: Readonly<Record<IconName, readonly string[]>> = {
  alert: ["M12 4 21 19H3z", "M12 10v4", "M12 17h.01"],
  check: ["M5 12.5 9.5 17 19 7.5"],
  "chevron-down": ["M6 9l6 6 6-6"],
  "chevron-right": ["M9 6l6 6-6 6"],
  close: ["M6 6l12 12", "M18 6 6 18"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
  external: ["M14 4h6v6", "M20 4l-8 8", "M18 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h5"],
  folder: ["M4 7h5l2 2h9v10H4z"],
  info: ["M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M12 11v5", "M12 8h.01"],
  "log-out": ["M10 5H5v14h5", "M15 8l4 4-4 4", "M19 12H9"],
  monitor: ["M4 5h16v11H4z", "M9 20h6", "M12 16v4"],
  more: ["M6 12h.01", "M12 12h.01", "M18 12h.01"],
  "panel-left": ["M4 5h16v14H4z", "M10 5v14"],
  plus: ["M12 5v14", "M5 12h14"],
  search: ["M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12z", "M20 20l-4.5-4.5"],
  send: ["M4 12l16-7-7 16-2-7z"],
  settings: [
    "M5 8h9",
    "M18 8h1",
    "M5 16h3",
    "M12 16h7",
    "M16 8a2 2 0 1 0 0 .01",
    "M10 16a2 2 0 1 0 0 .01",
  ],
  stop: ["M6 6h12v12H6z"],
  terminal: ["M5 7l4 4-4 4", "M12 16h7", "M4 5h16v14H4z"],
  trash: ["M5 7h14", "M9 7V5h6v2", "M7 7l1 13h8l1-13", "M10 11v5", "M14 11v5"],
};

export type IconProps = Omit<SVGProps<SVGSVGElement>, "name" | "ref"> & {
  readonly name: IconName;
  /** The glyph's pixel box; 16 is the register's default. */
  readonly size?: number;
};

export function Icon({ name, size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {iconPaths[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** The names the register ships, for tests and the specimen. */
export const iconNames = Object.keys(iconPaths) as readonly IconName[];
