import type { Icon as PhosphorIcon, IconProps as PhosphorIconProps } from "@phosphor-icons/react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/ssr/ArrowSquareOut";
import { CaretDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/ssr/Check";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/ssr/DotsThree";
import { DownloadIcon } from "@phosphor-icons/react/dist/ssr/Download";
import { FolderIcon } from "@phosphor-icons/react/dist/ssr/Folder";
import { GearIcon } from "@phosphor-icons/react/dist/ssr/Gear";
import { InfoIcon } from "@phosphor-icons/react/dist/ssr/Info";
import { ListIcon } from "@phosphor-icons/react/dist/ssr/List";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr/MagnifyingGlass";
import { MonitorIcon } from "@phosphor-icons/react/dist/ssr/Monitor";
import { MoonIcon } from "@phosphor-icons/react/dist/ssr/Moon";
import { PaperPlaneRightIcon } from "@phosphor-icons/react/dist/ssr/PaperPlaneRight";
import { PlusIcon } from "@phosphor-icons/react/dist/ssr/Plus";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/ssr/SidebarSimple";
import { SignOutIcon } from "@phosphor-icons/react/dist/ssr/SignOut";
import { StopIcon } from "@phosphor-icons/react/dist/ssr/Stop";
import { SunIcon } from "@phosphor-icons/react/dist/ssr/Sun";
import { TerminalIcon } from "@phosphor-icons/react/dist/ssr/Terminal";
import { TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash";
import { WarningIcon } from "@phosphor-icons/react/dist/ssr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/ssr/X";

/**
 * The one icon set (design record, Anti-goals: no emoji as interface icons).
 *
 * Every glyph is a Phosphor icon at the pinned regular weight, drawn in
 * `currentColor` so a control's text colour is its icon colour. Names stay the
 * register's own vocabulary — the Phosphor glyph behind each name is this
 * module's business, and vendored internals go through `Icon` rather than
 * importing a glyph directly.
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
  | "menu"
  | "monitor"
  | "moon"
  | "more"
  | "panel-left"
  | "plus"
  | "search"
  | "send"
  | "settings"
  | "stop"
  | "sun"
  | "terminal"
  | "trash";

const glyphs: Readonly<Record<IconName, PhosphorIcon>> = {
  alert: WarningIcon,
  check: CheckIcon,
  "chevron-down": CaretDownIcon,
  "chevron-right": CaretRightIcon,
  close: XIcon,
  download: DownloadIcon,
  external: ArrowSquareOutIcon,
  folder: FolderIcon,
  info: InfoIcon,
  "log-out": SignOutIcon,
  menu: ListIcon,
  monitor: MonitorIcon,
  moon: MoonIcon,
  more: DotsThreeIcon,
  "panel-left": SidebarSimpleIcon,
  plus: PlusIcon,
  search: MagnifyingGlassIcon,
  send: PaperPlaneRightIcon,
  settings: GearIcon,
  stop: StopIcon,
  sun: SunIcon,
  terminal: TerminalIcon,
  trash: TrashIcon,
};

export type IconProps = Omit<PhosphorIconProps, "name" | "ref" | "size" | "weight" | "color"> & {
  readonly name: IconName;
  readonly size?: number;
};

/**
 * A decorative glyph by default (`aria-hidden`), or an image with a name when
 * the caller passes `aria-label`. Everything else is the caller's SVG props.
 */
export function Icon({ name, size = 16, ...rest }: IconProps) {
  const Glyph = glyphs[name];
  const labelled = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;

  return (
    <Glyph
      {...rest}
      weight="regular"
      color="currentColor"
      size={size}
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
    />
  );
}

export const iconNames = Object.keys(glyphs) as readonly IconName[];
