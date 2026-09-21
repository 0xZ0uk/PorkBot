import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { TranscriptEntry } from "./console.ts";

/**
 * The transcript's reading position (story 18, slice 13.7): a conversation
 * opens on its newest turn, follows a streaming run while the reader is at the
 * bottom, and leaves the reader where they are — offering a jump back — the
 * moment they scroll up to read.
 *
 * The position is the scroller's own numbers, not a client-held cursor:
 * "at the latest" is within one small threshold of the bottom, so a fast
 * stream cannot lose the anchor to a rounding error, and "scrolled away" is
 * any distance beyond it. The follow flag is what makes the two behaviours
 * coexist — a new frame scrolls only if the reader had not left, so an
 * arriving token never yanks someone mid-read.
 */

/** Within this many pixels of the bottom still counts as following the run. */
export const atLatestThresholdPx = 48;

/** How far the scroller is from its newest content, in pixels. */
export function distanceFromLatest(element: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

/** True when the scroller is close enough to the bottom to be following it. */
export function isAtLatest(element: {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}): boolean {
  return distanceFromLatest(element) <= atLatestThresholdPx;
}

export interface TranscriptAnchor {
  /** Attach to the scrolling element. */
  readonly ref: RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  /** False once the reader has scrolled away from the newest content. */
  readonly atLatest: boolean;
  /** Puts the scroller back on the newest content and resumes following. */
  readonly jumpToLatest: () => void;
}

/**
 * `entries` is the anchor's clock: any change — a token, a tool call, a new
 * turn — is a chance to stay on the bottom, and the layout effect runs before
 * the browser paints, so the frame that added content is the frame that
 * scrolled.
 */
export function useTranscriptAnchor(entries: readonly TranscriptEntry[]): TranscriptAnchor {
  const ref = useRef<HTMLDivElement>(null);
  const [atLatest, setAtLatest] = useState(true);
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const element = ref.current;

    if (element === null) {
      return;
    }

    const next = isAtLatest(element);

    following.current = next;

    if (next !== atLatest) {
      setAtLatest(next);
    }
  }, [atLatest]);

  const jumpToLatest = useCallback(() => {
    const element = ref.current;

    following.current = true;
    setAtLatest(true);

    if (element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, []);

  useLayoutEffect(() => {
    const element = ref.current;

    if (element === null || !following.current) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [entries]);

  return { ref, onScroll, atLatest, jumpToLatest };
}
