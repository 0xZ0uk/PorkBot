import { colors } from "@porkbot/tokens";
import type { CSSProperties } from "react";

/** The four avatar sizes the register ships (design record, Identity). */
export type BotAvatarSize = 20 | 24 | 32 | 40;

export type BotAvatarProps = {
  /** Seeds the mascot; the same id draws the same shape and hue. */
  readonly id: string;
  /** The accessible name; an uploaded image also carries it as its alt text. */
  readonly name: string;
  /** The bot's own colour, which overrides the ramp hue. */
  readonly color?: string | null;
  /** An uploaded avatar, which replaces the mascot. */
  readonly imageUrl?: string | null;
  readonly size?: BotAvatarSize;
  readonly className?: string;
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

const shapes = [
  <rect key="square" x="5" y="5" width="30" height="30" rx="8" />,
  <circle key="circle" cx="20" cy="20" r="15" />,
  <path key="diamond" d="M20 4 36 20 20 36 4 20z" />,
  <path key="hex" d="M20 4 34 12v16L20 36 6 28V12z" />,
] as const;

/**
 * The mascot: a geometric shape with two eyes, both derived from the bot id.
 * Four shapes and two eye styles over twelve hues is enough distinct
 * identities for one operator's roster (design record, Identity).
 */
export function BotAvatar({ id, name, color, imageUrl, size = 32, className }: BotAvatarProps) {
  const classes = ["pb-avatar", `pb-avatar--${String(size)}`, className].filter(Boolean).join(" ");

  if (imageUrl !== undefined && imageUrl !== null) {
    return (
      <span className={classes}>
        <img className="pb-avatar__image" src={imageUrl} alt={name} />
      </span>
    );
  }

  const seed = seedOf(id);
  const shape = shapes[seed % shapes.length];
  const eyes = Math.floor(seed / shapes.length) % 2;
  const fill =
    color === undefined || color === null ? identityHues[seed % identityHues.length] : color;
  const eyeColor = colors.surface;

  return (
    <span className={classes} style={{ "--pb-avatar-color": fill } as CSSProperties}>
      <svg viewBox="0 0 40 40" width="100%" height="100%" role="img" aria-label={name}>
        {shape === undefined ? null : <g fill="var(--pb-avatar-color)">{shape}</g>}
        {eyes === 0 ? (
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
