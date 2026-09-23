import { colors } from "@porkbot/tokens";
import { cn } from "./lib/utils.ts";
import type { CSSProperties } from "react";

/** The four avatar sizes the register ships (design record, Identity). */
export type BotAvatarSize = 20 | 24 | 32 | 40;

export const botAvatarShapes = ["square", "circle", "diamond", "hexagon"] as const;
export type BotAvatarShape = (typeof botAvatarShapes)[number];
export type BotAvatarEyeStyle = "round" | "oval";

/** The stable visual choices derived from a bot id. */
export interface BotAvatarIdentity {
  readonly shape: BotAvatarShape;
  readonly eyeStyle: BotAvatarEyeStyle;
  /** The zero-based slot in the twelve-position identity ramp. */
  readonly hueIndex: number;
}

export type BotAvatarProps = {
  /** Seeds the mascot; the same id draws the same shape and hue. */
  readonly id: string;
  /** The bot name shown beside the decorative mark, and its hover label. */
  readonly name: string;
  /** The bot's own colour, which overrides the ramp hue. */
  readonly color?: string | null;
  /** An uploaded avatar, which replaces the mascot. */
  readonly imageUrl?: string | null;
  readonly size?: BotAvatarSize;
  readonly className?: string;
};

const sizeClass: Readonly<Record<BotAvatarSize, string>> = {
  20: "size-5",
  24: "size-6",
  32: "size-8",
  40: "size-10",
};

const identityHues = [
  colors.identity1,
  colors.identity2,
  colors.identity3,
  colors.identity4,
  colors.identity5,
  colors.identity6,
  colors.identity7,
  colors.identity8,
  colors.identity9,
  colors.identity10,
  colors.identity11,
  colors.identity12,
] as const;

/** FNV-1a, so the same id draws the same mascot in every process. */
function seedOf(value: string): number {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

/**
 * The identity function is deliberately pure and data-only. Keeping this
 * separate from the SVG means tests can assert the mapping over many ids
 * without snapshots, and every surface gets the same choices.
 */
export function botAvatarIdentity(id: string): BotAvatarIdentity {
  const seed = seedOf(id);

  return {
    shape: botAvatarShapes[seed % botAvatarShapes.length] ?? "square",
    eyeStyle: Math.floor(seed / botAvatarShapes.length) % 2 === 0 ? "round" : "oval",
    hueIndex: seed % identityHues.length,
  };
}

/**
 * The mascot: a geometric shape with two eyes, both derived from the bot id.
 * Four shapes and two eye styles over twelve hues is enough distinct
 * identities for one operator's roster (design record, Identity).
 */
export function BotAvatar({ id, name, color, imageUrl, size = 32, className }: BotAvatarProps) {
  const classes = cn(
    "inline-flex flex-none items-center justify-center overflow-hidden rounded-full bg-accent",
    sizeClass[size],
    className,
  );

  if (imageUrl !== undefined && imageUrl !== null && imageUrl.trim().length > 0) {
    return (
      <span className={classes} data-avatar aria-hidden="true" title={name}>
        <img className="size-full object-cover" src={imageUrl} alt="" />
      </span>
    );
  }

  const identity = botAvatarIdentity(id);
  const fill =
    color === undefined || color === null || color.trim().length === 0
      ? identityHues[identity.hueIndex]
      : color;
  const eyeColor = colors.surface;

  return (
    <span
      className={classes}
      data-avatar

      aria-hidden="true"
      title={name}
      style={{ "--pb-avatar-color": fill } as CSSProperties}
    >
      <svg viewBox="0 0 40 40" width="100%" height="100%" focusable="false">
        <g fill="var(--pb-avatar-color)">
          <AvatarShape shape={identity.shape} />
        </g>
        {identity.eyeStyle === "round" ? (
          <>
            <circle cx="14.5" cy="19" r="2.6" fill={eyeColor} />
            <circle cx="25.5" cy="19" r="2.6" fill={eyeColor} />
          </>
        ) : (
          <>
            <ellipse cx="14.5" cy="19" rx="2" ry="3.1" fill={eyeColor} />
            <ellipse cx="25.5" cy="19" rx="2" ry="3.1" fill={eyeColor} />
          </>
        )}
      </svg>
    </span>
  );
}

function AvatarShape({ shape }: Readonly<{ shape: BotAvatarShape }>) {
  switch (shape) {
    case "square":
      return <rect x="5" y="5" width="30" height="30" rx="8" />;
    case "circle":
      return <circle cx="20" cy="20" r="15" />;
    case "diamond":
      return <path d="M20 4 36 20 20 36 4 20z" />;
    case "hexagon":
      return <path d="M20 4 34 12v16L20 36 6 28V12z" />;
  }
}
