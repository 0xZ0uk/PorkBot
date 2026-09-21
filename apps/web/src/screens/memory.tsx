import { Button, Field, Input, Textarea } from "@porkbot/ui";
import { useState } from "react";
import type { MemoryDocumentView } from "@porkbot/contracts";
import type { MemoryNotice, MemoryScope, MemoryState } from "../memory.ts";

/**
 * The memory screen (slice 8.3, PRD decision 21; story 24): what a bot
 * remembers, correctable in place.
 *
 * The screen is a function of the controller's state. A live document card
 * reads as title, kind and revision with its content as the primary text — a
 * long note is summarized by a native disclosure rather than dumped, and the
 * full text is one expansion away. Its actions are the operator's: correct it
 * (title, content, why), remove it (with a reason), and open the history.
 *
 * The history is the audit trail: every revision with who made it, when, why,
 * and the state at the time, so a wrong rewrite is visible rather than silent.
 * Restoring a revision reapplies it as the next one; the reason recorded is
 * the action itself, because the revision's own "why" is history and a restore
 * does not rewrite it. The `Removed` scope lists tombstones with a restore
 * button, which is how a deleted document comes back under its own id.
 *
 * Empty and long states are designed, not left raw: an empty scope says so in
 * one sentence, and a document whose content overflows is folded behind a
 * summary instead of filling the page.
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
      <section className="console">
        <p className="form-error" role="alert">
          {state.refusal}
        </p>
        <Button onClick={onRetry}>Try again</Button>
      </section>
    );
  }

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      <header className="memory-header">
        <h2>Memory</h2>
        <div className="memory-scopes" role="group" aria-label="Which documents to show">
          <Button
            aria-pressed={state.scope === "active"}
            onClick={() => {
              onScope("active");
            }}
          >
            Current
          </Button>
          <Button
            aria-pressed={state.scope === "deleted"}
            onClick={() => {
              onScope("deleted");
            }}
          >
            Removed
          </Button>
        </div>
      </header>

      {state.documents.length === 0 ? (
        state.status === "ready" ? (
          <p className="muted">
            {state.scope === "active" ? "Nothing remembered yet." : "Nothing removed."}
          </p>
        ) : null
      ) : (
        <ul className="memory-list">
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

  async function restore(revision: number): Promise<void> {
    await onRestore({
      documentId: document.documentId,
      revision,
      reason: `Restored revision ${revision}`,
    });
  }

  return (
    <li className={document.deletedAt === null ? "memory-document" : "memory-document removed"}>
      <div className="memory-document-header">
        <h3>{document.title}</h3>
        <span className="memory-kind">{kindLabels[document.kind]}</span>
        <span className="memory-revision muted">v{document.revision}</span>
      </div>

      <MemoryText text={document.content} className="memory-content" />

      {notice === null ? null : (
        <p
          className={notice.kind === "error" ? "form-error" : "muted"}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      )}

      <div className="memory-actions">
        {scope === "deleted" ? (
          <Button
            disabled={pending}
            onClick={() => {
              void restore(document.revision);
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
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setRemoving(!removing);
              }}
            >
              {removing ? "Cancel" : "Delete"}
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
        <RemoveForm
          documentId={document.documentId}
          pending={pending}
          onSubmit={async (input) => {
            if (await onRemove(input)) {
              setRemoving(false);
            }
          }}
        />
      ) : null}

      {historyOpen ? (
        <RevisionHistory history={history} pending={pending} onRestore={restore} />
      ) : null}
    </li>
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
      className="memory-form"
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
      <Button type="submit" disabled={pending}>
        Save
      </Button>
    </form>
  );
}

interface RemoveFormProps {
  readonly documentId: string;
  readonly pending: boolean;
  readonly onSubmit: (input: {
    readonly documentId: string;
    readonly reason: string;
  }) => Promise<void>;
}

function RemoveForm({ documentId, pending, onSubmit }: RemoveFormProps) {
  const [reason, setReason] = useState("");

  return (
    <form
      className="memory-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ documentId, reason });
      }}
    >
      <p className="muted">Removing keeps the history and can be undone from the Removed list.</p>
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
      <Button type="submit" disabled={pending}>
        Delete
      </Button>
    </form>
  );
}

interface RevisionHistoryProps {
  readonly history: MemoryState["history"][string] | undefined;
  readonly pending: boolean;
  readonly onRestore: (revision: number) => Promise<void>;
}

function RevisionHistory({ history, pending, onRestore }: RevisionHistoryProps) {
  if (history === undefined || history.status === "loading") {
    return <p className="muted">Loading history…</p>;
  }

  if (history.status === "refused") {
    return (
      <p className="form-error" role="alert">
        The history could not be loaded.
      </p>
    );
  }

  return (
    <ol className="revision-list">
      {history.revisions.map((revision) => (
        <li
          key={revision.revision}
          className={revision.deleted ? "revision revision-deleted" : "revision"}
        >
          <div className="revision-header">
            <span className="memory-revision muted">v{revision.revision}</span>
            <span className="revision-author">
              {revision.origin === "agent_proposed" ? "Bot" : "You"}
            </span>
            <time className="muted" dateTime={revision.createdAt}>
              {new Date(revision.createdAt).toLocaleString()}
            </time>
            {revision.deleted ? <span className="revision-removed">Removed</span> : null}
          </div>
          <p className="revision-reason">{revision.reason}</p>
          <MemoryText text={revision.content} className="revision-content" />
          <Button
            disabled={pending}
            onClick={() => {
              void onRestore(revision.revision);
            }}
          >
            Restore this revision
          </Button>
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
    <details className="memory-text-details">
      <summary className="memory-summary">{text.slice(0, limit)}…</summary>
      <p className={className}>{text}</p>
    </details>
  );
}
