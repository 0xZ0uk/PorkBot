import { clsx } from "clsx";
import type { ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The class composer every vendored component writes its strings through:
 * `clsx` for the joins, `tailwind-merge` so a caller's `className` can override
 * the register's own utilities instead of piling up beside them.
 */
export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
