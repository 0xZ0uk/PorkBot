import type { PromptSection } from "./prompt-composition.ts";

/**
 * Untrusted ingestion: the one place external content becomes a labelled value
 * (PRD decision 30; slice 10.1).
 *
 * The product's core risk is an agent reading the web, a file, an email or a
 * tool result that carries instructions. The defence starts at the boundary
 * that received the content: the module that fetched, parsed or opened it calls
 * `labelUntrustedContent`, and everything downstream sees provenance and a
 * label instead of a bare string that could be mistaken for something the
 * operator said.
 *
 * This module is the vocabulary, not the boundary. It does not fetch, parse or
 * store anything: a caller hands it what it received and where the content came
 * from, and the result is an `UntrustedContent` whose `label` is the literal
 * `"untrusted"`. `INGESTION_PATHS` is the exhaustive list of ways content
 * enters, and a path that is not on it is refused rather than labelled, so a
 * new ingestion surface cannot quietly borrow the label. The call-site test in
 * `ingestion.call-sites.test.ts` walks the shipped tree and fails any consumer
 * of a registered boundary that does not label.
 *
 * Instruction/data separation is the second half. `untrustedPromptSection`
 * turns a labelled value into a `PromptSection` in the composer's `data`
 * channel, which the composer wraps in `DATA_CHANNEL_NOTICE`; a data body is
 * labelled rather than escaped, because escaping prose cannot be made sound.
 * Tool results are labelled the same way: what a tool returns to the model
 * carries the label, so the model is told the content is data and never
 * instructed to obey it.
 *
 * The functions are pure — no clock, no network, no store — so one fixture can
 * stand for every caller and the boundary tests need nothing but a value.
 */

export const INGESTION_PATHS = [
  "web_fetch",
  "file_read",
  "email",
  "mcp_output",
  "computer_output",
] as const;

export type IngestionPath = (typeof INGESTION_PATHS)[number];

/**
 * What each path means, and the exported name of the seam whose raw output it
 * is. The call-site test reads this register: every path must have a boundary
 * there, and every adversarial suite that feeds hostile content must cover
 * every id.
 */
export interface IngestionPathDefinition {
  readonly id: IngestionPath;
  readonly description: string;
  readonly seam: string;
}

export const INGESTION_PATH_DEFINITIONS: readonly IngestionPathDefinition[] = [
  {
    id: "web_fetch",
    description: "A page or search result returned by the web-access provider.",
    seam: "WebAccessProvider",
  },
  {
    id: "file_read",
    description: "Bytes read from a file the run did not write.",
    seam: "ComputerProvider",
  },
  {
    id: "email",
    description: "An inbound email or webhook message body.",
    seam: "WebhookEvent",
  },
  {
    id: "mcp_output",
    description: "A result returned by an MCP server or a vendor tool call.",
    seam: "parsePiEvent",
  },
  {
    id: "computer_output",
    description:
      "Text a computer tool returned: shell stdout, a directory listing, or the page text a browser action read back.",
    seam: "ComputerProvider",
  },
];

/** The one label external content may carry. */
export const UNTRUSTED_LABEL = "untrusted" as const;

export type UntrustedLabel = typeof UNTRUSTED_LABEL;

/**
 * External content with its provenance attached. The literal `label` is the
 * point: a value of this type cannot have come from the operator or the
 * system, and a consumer that needs to tell them apart reads it rather than
 * guessing from a field name.
 */
export interface UntrustedContent {
  readonly label: UntrustedLabel;
  readonly path: IngestionPath;
  /**
   * Where the content came from, as the boundary can attribute it: a final
   * URL, a home-relative path, a sender, a server and tool name. A
   * credential-bearing URL is stripped by the boundary before labelling.
   */
  readonly origin: string;
  readonly content: string;
  /** ISO-8601 instant the boundary received the content, when it tracks one. */
  readonly retrievedAt?: string | undefined;
}

export interface UntrustedContentInput {
  readonly path: IngestionPath;
  readonly origin: string;
  readonly content: string;
  readonly retrievedAt?: string | undefined;
}

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

export class UnknownIngestionPath extends IngestionError {
  readonly value: unknown;

  constructor(value: unknown) {
    super(
      `Unknown ingestion path: ${String(value)}; a new path must join INGESTION_PATHS before its content can be labelled`,
    );
    this.name = "UnknownIngestionPath";
    this.value = value;
  }
}

export class MissingContentOrigin extends IngestionError {
  readonly path: IngestionPath;

  constructor(path: IngestionPath) {
    super(
      `Ingestion path "${path}" requires a non-blank origin; unattributed content cannot be audited or shown to the model`,
    );
    this.name = "MissingContentOrigin";
    this.path = path;
  }
}

export class InvalidIngestedContent extends IngestionError {
  readonly path: IngestionPath;

  constructor(path: IngestionPath) {
    super(`Ingestion path "${path}" received content that is not a string`);
    this.name = "InvalidIngestedContent";
    this.path = path;
  }
}

/** A value that is not the labelled shape, e.g. a raw string where one is required. */
export class UnlabelledContent extends IngestionError {
  constructor() {
    super("Expected content labelled untrusted; label it at the boundary before use");
    this.name = "UnlabelledContent";
  }
}

export function isIngestionPath(value: unknown): value is IngestionPath {
  return typeof value === "string" && (INGESTION_PATHS as readonly string[]).includes(value);
}

/**
 * The origin with any embedded credentials removed. A boundary that received a
 * credential-bearing URL must not echo it into a prompt, a tool result or a
 * log, so the label carries the destination without the secret; an origin that
 * is not a URL is returned unchanged.
 */
export function stripOriginCredentials(origin: string): string {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return origin;
  }

  if (url.username === "" && url.password === "") {
    return origin;
  }

  url.username = "";
  url.password = "";

  return url.href;
}

/**
 * Labelled content as the boundary builds it. An unknown path, a blank origin
 * or a non-string payload is a programming error at the boundary, so it throws
 * rather than returning a value that looks labelled but is not. Empty content
 * is accepted: an empty page is still a fact the model may need. Credentials in
 * a URL-shaped origin are stripped here, because the label is the one value
 * every downstream surface renders.
 */
export function labelUntrustedContent(input: UntrustedContentInput): UntrustedContent {
  if (!isIngestionPath(input.path)) {
    throw new UnknownIngestionPath(input.path);
  }

  if (typeof input.content !== "string") {
    throw new InvalidIngestedContent(input.path);
  }

  const rawOrigin = typeof input.origin === "string" ? input.origin.trim() : "";

  if (rawOrigin === "") {
    throw new MissingContentOrigin(input.path);
  }

  return {
    label: UNTRUSTED_LABEL,
    path: input.path,
    origin: stripOriginCredentials(rawOrigin),
    content: input.content,
    ...(input.retrievedAt === undefined ? {} : { retrievedAt: input.retrievedAt }),
  };
}

export function isUntrustedContent(value: unknown): value is UntrustedContent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    candidate["label"] === UNTRUSTED_LABEL &&
    isIngestionPath(candidate["path"]) &&
    typeof candidate["origin"] === "string" &&
    candidate["origin"].trim() !== "" &&
    typeof candidate["content"] === "string"
  );
}

export interface UntrustedSectionOptions {
  /** The section id, unique among a prompt's caller sections. */
  readonly id: string;
  readonly order: number;
  /** Defaults to `"External content"`. */
  readonly heading?: string | undefined;
}

const DEFAULT_UNTRUSTED_HEADING = "External content";

/**
 * The labelled value as a prompt section in the `data` channel. The provenance
 * line opens the body so the model can attribute what follows, and the
 * composer adds the data notice when it renders the section. The content is
 * neither escaped nor rewritten: a producer that owns the label owns the text.
 */
export function untrustedPromptSection(
  content: UntrustedContent,
  options: UntrustedSectionOptions,
): PromptSection {
  if (!isUntrustedContent(content)) {
    throw new UnlabelledContent();
  }

  const heading = (options.heading ?? DEFAULT_UNTRUSTED_HEADING).trim();

  return {
    id: options.id,
    heading: heading === "" ? DEFAULT_UNTRUSTED_HEADING : heading,
    channel: "data",
    order: options.order,
    content: `Source: ${content.path} (${content.origin})\n\n${content.content}`,
  };
}
