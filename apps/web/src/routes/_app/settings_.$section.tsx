import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

/**
 * The old per-section settings paths (slice 11.5), retired by slice 13.13: each
 * one now lands on its section inside the single surface, so a bookmark or a
 * walkthrough written against `/settings/mcp` arrives where it meant to rather
 * than at a not-found. A segment the panel has no section for is a genuine
 * not-found instead of a silent trip to the top of the panel.
 */

const anchors: Readonly<Record<string, string>> = {
  connections: "models",
  mcp: "mcp",
  secrets: "secrets",
  notifications: "notifications",
  usage: "usage",
  account: "account",
};

export const Route = createFileRoute("/_app/settings_/$section")({
  beforeLoad: ({ params }) => {
    const anchor = anchors[params.section];

    if (anchor === undefined) {
      throw notFound();
    }

    throw redirect({ to: "/settings", hash: anchor });
  },
});
