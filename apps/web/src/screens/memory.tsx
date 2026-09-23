import { Badge, Button, Card, Field, Input, SegmentedControl, Textarea } from "@porkbot/ui";
import { useState } from "react";
import type { MemoryDocumentView, MemoryRevisionView } from "@porkbot/contracts";
import type { MemoryNotice, MemoryScope, MemoryState } from "../memory.ts";
import { MemorySkeleton } from "./loading.tsx";

/**
 * The memory screen (slice 13.12, stories 23 and 24; design record, Records):
 * what a bot remembers, correctable in place.
 *
 * A document is a card. The card names its kind and title, the text the bot
 * carries, and the last change's hand and instant — read from the list's own
 * joined revision rather than inferred — with the revision history as a
 * timeline inside the card instead of a stack of boxes. Every revision offers
 * the restore that reapplies it, so a wrong rewrite is visible and reversible
 * rather than silent.
 *
 * The scopes are a segmented control: Current and Removed are one glance
 * apart, and a removed document keeps its dashed card, its destructive mark
 * and the instant of its removal. Removing and restoring are inline
 * confirmations that state the consequence — the history survives a removal,
 * and a restore becomes the newest revision — and both carry the reason the
 * wire records. A restore from the Removed list names the tombstone revision
 * the list already holds, so the screen never guesses a revision number.
 */

export interface MemoryScreenProps {
  readonly state: MemoryState;
  readonly onScope: (scope: MemoryScope) => void;
  readonly onRetry: () => void;
  readonly onToggleHistory: (documentId: string) => void;
  readonly onSave: (input: {
    readonly documentId: string;
    readonly title: string;
    readonly content: string;
    readonly reason: string;
  }) => Promise<boolean>;
  readonly onRemove: (input: {
    readonly documentId: string;
    readonly reason: string;
  }) => Promise<boolean>;
  readonly onRestore: (input: {
    readonly documentId: string;
    readonly revision: number;
    readonly reason: string;
  }) => Promise<boolean>;
}

const kindLabels: Record<MemoryDocumentView["kind"], string> = {
  fact: "Fact",
  preference: "Preference",
  decision: "Decision",
};

const scopeOptions = [
  { value: "active", label: "Current" },
  { value: "deleted", label: "Removed" },
] as const;

/** The origin as the operator's word: the store's author is an id, not a name. */
function originLabel(origin: MemoryRevisionView["origin"]): string {
  return origin === "agent_proposed" ? "Bot" : "You";
}

/** One instant, as its own calendar date and time; the exact value stays in the DOM. */
function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function MemoryScreen({
  state,
  onScope,
  onRetry,
  onToggleHistory,
  onSave,
  onRemove,
  onRestore,
}: MemoryScreenProps) {
  if (state.status === "refused") {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {state.refusal}
        </p>
        <Button onClick={onRetry}>Try again</Button>
      </section>
    );
  }

  if (state.status === "loading") {
    return <MemorySkeleton />;
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div>
          <h2>Memory</h2>
          <p className="text-muted-foreground">What this bot remembers, correctable in place.</p>
        </div>
        <SegmentedControl
          label="Which documents to show"
          options={scopeOptions}
          value={state.scope}
          onChange={(scope) => {
            onScope(scope as MemoryScope);
          }}
        />
      </header>

      {state.documents.length === 0 ? (
        state.status === "ready" ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
            <h3>{state.scope === "active" ? "Nothing remembered yet" : "Nothing removed"}</h3>
            <p className="text-muted-foreground">
              {state.scope === "active"
                ? "This bot has no durable documents."
                : "A removed document keeps its history and can be restored."}
            </p>
          </div>
        ) : null
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {state.documents.map((document) => (
            <MemoryDocumentCard
              key={document.documentId}
              document={document}
              scope={state.scope}
              history={state.history[document.documentId]}
              historyOpen={state.openHistory.includes(document.documentId)}
              notice={state.notice?.documentId === document.documentId ? state.notice : null}
              pending={state.pendingDocumentId === document.documentId}
              onToggleHistory={onToggleHistory}
              onSave={onSave}
              onRemove={onRemove}
              onRestore={onRestore}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface MemoryDocumentCardProps {
  readonly document: MemoryDocumentView;
  readonly scope: MemoryScope;
  readonly history: MemoryState["history"][string] | undefined;
  readonly historyOpen: boolean;
  readonly notice: MemoryNotice | null;
  readonly pending: boolean;
  readonly onToggleHistory: (documentId: string) => void;
  readonly onSave: MemoryScreenProps["onSave"];
  readonly onRemove: MemoryScreenProps["onRemove"];
  readonly onRestore: MemoryScreenProps["onRestore"];
}

function MemoryDocumentCard({
  document,
  scope,
  history,
  historyOpen,
  notice,
  pending,
  onToggleHistory,
  onSave,
  onRemove,
  onRestore,
}: MemoryDocumentCardProps) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  // Which revision is being confirmed, and where the request came from: the
  // tombstone's own button confirms under the actions, a timeline entry
  // confirms inside itself, and the two are never drawn together.
  const [restoring, setRestoring] = useState<{
    readonly revision: number;
    readonly from: "card" | "timeline";
  } | null>(null);
  const removed = document.deletedAt !== null;

  async function restore(revision: number, reason: string): Promise<boolean> {
    const applied = await onRestore({ documentId: document.documentId, revision, reason });

    if (applied) {
      setRestoring(null);
    }

    return applied;
  }

  return (
    <Card
      as="li"
      variant="raised"
      className={
        removed
          ? "flex flex-col gap-2 rounded-lg border border-border bg-card p-3 border-dashed"
          : "flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
      }
      data-removed={removed ? "true" : undefined}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3>{document.title}</h3>
        <Badge>{kindLabels[document.kind]}</Badge>
        {removed ? <Badge tone="destructive">Removed</Badge> : null}
        <span className="ml-auto text-meta text-muted-foreground">v{document.revision}</span>
      </div>

      <p className="m-0 text-meta text-muted-foreground">
        Last change by {originLabel(document.lastChangedOrigin)} ·{" "}
        <time dateTime={document.lastChangedAt}>{formatInstant(document.lastChangedAt)}</time>
      </p>

      <MemoryText text={document.content} className="m-0 wrap-anywhere whitespace-pre-wrap" />

      {notice === null ? null : (
        <p
          className={
            notice.kind === "error"
              ? "rounded-md border border-destructive bg-card p-2 text-foreground"
              : "text-muted-foreground"
          }
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {scope === "deleted" ? (
          <Button
            variant="primary"
            disabled={pending}
            onClick={() => {
              setRestoring({ revision: document.revision, from: "card" });
            }}
          >
            Restore
          </Button>
        ) : (
          <>
            <Button
              disabled={pending}
              onClick={() => {
                setRemoving(false);
                setEditing(!editing);
              }}
            >
              {editing ? "Cancel" : "Edit"}
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setRemoving(true);
              }}
            >
              Remove
            </Button>
          </>
        )}
        <Button
          aria-expanded={historyOpen}
          onClick={() => {
            onToggleHistory(document.documentId);
          }}
        >
          {historyOpen ? "Hide history" : "History"}
        </Button>
      </div>

      {editing ? (
        <EditForm
          document={document}
          pending={pending}
          onSubmit={async (input) => {
            if (await onSave(input)) {
              setEditing(false);
            }
          }}
        />
      ) : null}

      {removing ? (
        <RemoveConfirm
          document={document}
          pending={pending}
          onCancel={() => {
            setRemoving(false);
          }}
          onSubmit={async (reason) => {
            const applied = await onRemove({ documentId: document.documentId, reason });

            if (applied) {
              setRemoving(false);
            }

            return applied;
          }}
        />
      ) : null}

      {restoring?.from === "card" ? (
        <RestoreConfirm
          document={document}
          revision={restoring.revision}
          pending={pending}
          onCancel={() => {
            setRestoring(null);
          }}
          onSubmit={(reason) => restore(restoring.revision, reason)}
        />
      ) : null}

      {historyOpen ? (
        <RevisionTimeline
          document={document}
          history={history}
          pending={pending}
          restoring={restoring?.from === "timeline" ? restoring.revision : null}
          onRestore={(revision) => {
            setRestoring({ revision, from: "timeline" });
          }}
          onCancelRestore={() => {
            setRestoring(null);
          }}
          onSubmitRestore={(revision, reason) => restore(revision, reason)}
        />
      ) : null}
    </Card>
  );
}

interface EditFormProps {
  readonly document: MemoryDocumentView;
  readonly pending: boolean;
  readonly onSubmit: (input: {
    readonly documentId: string;
    readonly title: string;
    readonly content: string;
    readonly reason: string;
  }) => Promise<void>;
}

function EditForm({ document, pending, onSubmit }: EditFormProps) {
  const [title, setTitle] = useState(document.title);
  const [content, setContent] = useState(document.content);
  const [reason, setReason] = useState("");

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      data-memory-form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ documentId: document.documentId, title, content, reason });
      }}
    >
      <Field label="Title">
        <Input
          required
          maxLength={200}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </Field>
      <Field label="Content">
        <Textarea
          required
          maxLength={8_000}
          rows={5}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
          }}
        />
      </Field>
      <Field label="Why this change">
        <Input
          required
          maxLength={500}
          placeholder="Recorded on the revision"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <Button className="self-start" type="submit" variant="primary" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

interface RemoveConfirmProps {
  readonly document: MemoryDocumentView;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => Promise<boolean>;
}

/**
 * A removal is a confirmation that names its consequence: the document leaves
 * the current list, its history and its id stay, and the Removed scope can
 * bring it back. It is inline rather than a modal — the card the decision is
 * about stays visible — and the reason is required because the wire records
 * one.
 */
function RemoveConfirm({ document, pending, onCancel, onSubmit }: RemoveConfirmProps) {
  const [reason, setReason] = useState("");

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      data-memory-form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(reason);
      }}
    >
      <p className="m-0 wrap-anywhere text-body" role="note">
        Removing &quot;{document.title}&quot; leaves Current. Its history and its id are kept, and
        you can restore it from Removed.
      </p>
      <Field label="Why remove it">
        <Input
          required
          maxLength={500}
          placeholder="Recorded on the revision"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending || reason.trim() === ""}>
          Remove document
        </Button>
      </div>
    </form>
  );
}

interface RestoreConfirmProps {
  readonly document: MemoryDocumentView;
  readonly revision: number;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (reason: string) => Promise<boolean>;
}

/**
 * A restore is a confirmation too: the chosen revision becomes the newest
 * revision, and a removed document returns to Current. It is inline beside the
 * revision — or in the tombstone's card — and the reason is prefilled with the
 * action so the operator confirms rather than authors it.
 */
function RestoreConfirm({ document, revision, pending, onCancel, onSubmit }: RestoreConfirmProps) {
  const [reason, setReason] = useState(`Restored revision ${String(revision)}`);
  const removed = document.deletedAt !== null;

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      data-memory-form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(reason);
      }}
    >
      <p className="m-0 wrap-anywhere text-body" role="note">
        {removed
          ? `Restoring revision ${String(revision)} returns "${document.title}" to Current as its newest revision.`
          : `Restoring revision ${String(revision)} makes its text the newest revision; nothing already recorded is erased.`}
      </p>
      <Field label="Why restore it">
        <Input
          required
          maxLength={500}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || reason.trim() === ""}>
          Restore revision
        </Button>
      </div>
    </form>
  );
}

interface RevisionTimelineProps {
  readonly document: MemoryDocumentView;
  readonly history: MemoryState["history"][string] | undefined;
  readonly pending: boolean;
  readonly restoring: number | null;
  readonly onRestore: (revision: number) => void;
  readonly onCancelRestore: () => void;
  readonly onSubmitRestore: (revision: number, reason: string) => Promise<boolean>;
}

/**
 * The history as a timeline: oldest first, each entry a marker on one vertical
 * rule, with who, when, why and the text at the time. A restore is offered on
 * every revision; the newest entry is marked so the current state is visible
 * in the history rather than inferred from the number. Choosing a revision
 * opens the confirmation inside that entry, so the text being reapplied and
 * the consequence sit together.
 */
function RevisionTimeline({
  document,
  history,
  pending,
  restoring,
  onRestore,
  onCancelRestore,
  onSubmitRestore,
}: RevisionTimelineProps) {
  if (history === undefined || history.status === "loading") {
    return <p className="text-muted-foreground">Loading history…</p>;
  }

  if (history.status === "refused") {
    return (
      <p className="rounded-md border border-destructive bg-card p-2 text-foreground" role="alert">
        The history could not be loaded.
      </p>
    );
  }

  const latest = history.revisions[history.revisions.length - 1]?.revision;

  return (
    <ol className="relative m-0 flex list-none flex-col gap-4 border-l border-border p-0 pl-4">
      {history.revisions.map((revision) => (
        <li
          key={revision.revision}
          className="relative flex flex-col gap-1"
          data-memory-timeline-entry
          data-latest={revision.revision === latest ? "true" : undefined}
          data-deleted={revision.deleted ? "true" : undefined}
        >
          <span
            className="absolute -left-4 top-1 size-2 rounded-full bg-muted-foreground"
            aria-hidden="true"
          />
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="ml-auto text-meta text-muted-foreground">v{revision.revision}</span>
            <span>{originLabel(revision.origin)}</span>
            <time className="text-muted-foreground" dateTime={revision.createdAt}>
              {formatInstant(revision.createdAt)}
            </time>
            {revision.deleted ? <Badge tone="destructive">Removed</Badge> : null}
          </div>
          <p className="m-0 wrap-anywhere text-body">{revision.reason}</p>
          <MemoryText text={revision.content} className="m-0 wrap-anywhere whitespace-pre-wrap" />
          <Button
            className="self-start"
            disabled={pending}
            onClick={() => {
              onRestore(revision.revision);
            }}
          >
            Restore this revision
          </Button>
          {restoring === revision.revision ? (
            <RestoreConfirm
              document={document}
              revision={revision.revision}
              pending={pending}
              onCancel={onCancelRestore}
              onSubmit={(reason) => onSubmitRestore(revision.revision, reason)}
            />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Content rendered as a summary for anything long and whole for anything
 * short: a durable fact can run to kilobytes, and a card that renders all of
 * it is a raw dump. The disclosure is native (`<details>`), so the collapsed
 * state is visible without a line-clamp CSS trick and the full text is one
 * expansion away.
 */
function MemoryText({ text, className }: { readonly text: string; readonly className: string }) {
  const limit = 320;

  if (text.length <= limit) {
    return <p className={className}>{text}</p>;
  }

  return (
    <details className="">
      <summary className="wrap-anywhere whitespace-pre-wrap text-muted-foreground">
        {text.slice(0, limit)}…
      </summary>
      <p className={className}>{text}</p>
    </details>
  );
}
