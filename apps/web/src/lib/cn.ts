/** Class joiner: filters falsy values and joins the rest. */
export function cn(...inputs: readonly (string | false | null | undefined)[]): string {
  return inputs.filter(Boolean).join(" ");
}
