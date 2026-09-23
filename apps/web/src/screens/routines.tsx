import type { Routine, RoutineOutcome } from "@porkbot/contracts";
import { Badge, Button, Card, Field, Input, Textarea } from "@porkbot/ui";
import { useState } from "react";
import type { ReactNode } from "react";
import type {
  RoutinePreviewState,
  RoutineScheduleInput,
  RoutineTestRunResult,
  RoutineUpdateInput,
} from "../routines.ts";
import { describeRoutineSchedule, routineOutcomeLabel, routineTestRunNonce } from "../routines.ts";

export interface RoutinesScreenProps {
  readonly botId: string;
  readonly routines: readonly Routine[];
  readonly outcomes: Readonly<Record<string, readonly RoutineOutcome[]>>;
  readonly creating: boolean;
  readonly editingRoutineId: string | null;
  readonly pending: string | null;
  readonly notice: string | null;
  readonly preview: RoutinePreviewState;
  readonly onCreateOpen: () => void;
  readonly onEdit: (routine: Routine) => void;
  readonly onCloseEditor: () => void;
  readonly onPreview: (input: {
    readonly cron: string;
    readonly timezone: string;
    readonly count: number;
  }) => void;
  readonly onCreate: (input: RoutineScheduleInput & { readonly botId: string }) => Promise<boolean>;
  readonly onUpdate: (input: RoutineUpdateInput) => Promise<boolean>;
  readonly onToggle: (routine: Routine) => void;
  readonly onRemove: (routine: Routine) => void;
  readonly onTestRun: (routine: Routine, clientNonce: string) => Promise<RoutineTestRunResult>;
}

export function RoutinesScreen({
  botId,
  routines,
  outcomes,
  creating,
  editingRoutineId,
  pending,
  notice,
  preview,
  onCreateOpen,
  onEdit,
  onCloseEditor,
  onPreview,
  onCreate,
  onUpdate,
  onToggle,
  onRemove,
  onTestRun,
}: RoutinesScreenProps) {
  const editingRoutine =
    editingRoutineId === null
      ? null
      : (routines.find((routine) => routine.id === editingRoutineId) ?? null);

  function openCreate(): void {
    onPreview({ cron: "0 9 * * 1-5", timezone: "UTC", count: 5 });
    onCreateOpen();
  }

  function openEdit(routine: Routine): void {
    onPreview({ cron: routine.cron, timezone: routine.timezone, count: 5 });
    onEdit(routine);
  }

  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col gap-3 gap-4"
      aria-busy={pending !== null}
    >
      <header className="flex flex-col gap-1 flex-wrap items-center gap-3">
        <div>
          <h2>Routines</h2>
          <p className="text-muted-foreground">
            Schedule repeatable work and see every slot the scheduler settles.
          </p>
        </div>
        <Button variant="primary" onClick={openCreate} aria-expanded={creating}>
          {creating ? "Close editor" : "New routine"}
        </Button>
      </header>

      {notice === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {notice}
        </p>
      )}

      {creating ? (
        <RoutineEditor
          key="new"
          botId={botId}
          routine={null}
          pending={pending === "create"}
          preview={preview}
          onPreview={onPreview}
          onClose={onCloseEditor}
          onSubmit={async (input) => {
            const created = await onCreate(input);

            if (created) {
              onCloseEditor();
            }

            return created;
          }}
        />
      ) : editingRoutine === null ? null : (
        <RoutineEditor
          key={`${editingRoutine.id}:${editingRoutine.updatedAt}`}
          botId={botId}
          routine={editingRoutine}
          pending={pending === `save:${editingRoutine.id}`}
          preview={preview}
          onPreview={onPreview}
          onClose={onCloseEditor}
          onSubmit={async (input) => {
            const updated = await onUpdate({
              id: editingRoutine.id,
              instruction: input.instruction,
              cron: input.cron,
              timezone: input.timezone,
            });

            if (updated) {
              onCloseEditor();
            }

            return updated;
          }}
        />
      )}

      {routines.length === 0 && !creating ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
          <h3>No routines yet</h3>
          <p className="text-muted-foreground">
            Create one to give this bot recurring work and a visible history.
          </p>
          <Button onClick={openCreate}>Create routine</Button>
        </div>
      ) : routines.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {routines.map((routine) => (
            <RoutineCard
              key={routine.id}
              botId={botId}
              routine={routine}
              outcomes={outcomes[routine.id] ?? []}
              pending={pending?.endsWith(`:${routine.id}`) === true}
              testPending={pending === `test:${routine.id}`}
              onEdit={openEdit}
              onToggle={onToggle}
              onRemove={onRemove}
              onTestRun={onTestRun}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

interface RoutineEditorProps {
  readonly botId: string;
  readonly routine: Routine | null;
  readonly pending: boolean;
  readonly preview: RoutinePreviewState;
  readonly onPreview: RoutinesScreenProps["onPreview"];
  readonly onClose: () => void;
  readonly onSubmit: (input: RoutineScheduleInput & { readonly botId: string }) => Promise<boolean>;
}

interface RoutineEditorValues {
  readonly instruction: string;
  readonly cron: string;
  readonly timezone: string;
}

function RoutineEditor({
  botId,
  routine,
  pending,
  preview,
  onPreview,
  onClose,
  onSubmit,
}: RoutineEditorProps) {
  const [values, setValues] = useState<RoutineEditorValues>(() =>
    routine === null
      ? { instruction: "", cron: "0 9 * * 1-5", timezone: "UTC" }
      : { instruction: routine.instruction, cron: routine.cron, timezone: routine.timezone },
  );
  const [errors, setErrors] = useState<Partial<Record<keyof RoutineEditorValues, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  function change<Key extends keyof RoutineEditorValues>(
    key: Key,
    value: RoutineEditorValues[Key],
  ): void {
    const next = { ...values, [key]: value };
    setValues(next);
    setErrors({ ...errors, [key]: undefined });
    setSaveError(null);

    if (key === "cron" || key === "timezone") {
      onPreview({ cron: next.cron, timezone: next.timezone, count: 5 });
    }
  }

  async function submit(): Promise<void> {
    const nextErrors: Partial<Record<keyof RoutineEditorValues, string>> = {};

    if (values.instruction.trim() === "") {
      nextErrors.instruction = "Describe the work this routine should start.";
    }

    if (values.cron.trim() === "") {
      nextErrors.cron = "Enter a five-field cron expression.";
    }

    if (values.timezone.trim() === "") {
      nextErrors.timezone = "Enter an IANA timezone such as UTC.";
    }

    setErrors(nextErrors);
    setSaveError(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    try {
      const saved = await onSubmit({ botId, ...values });

      if (!saved) {
        setSaveError("The routine could not be saved. Check the schedule and try again.");
      }
    } catch {
      setSaveError("The routine could not be saved. Check the schedule and try again.");
    }
  }

  return (
    <section
      className="flex flex-col gap-3"
      aria-label={routine === null ? "New routine" : "Edit routine"}
    >
      <header className="flex flex-wrap items-center gap-2">
        <div>
          <h3>{routine === null ? "New routine" : "Edit routine"}</h3>
          <p className="text-muted-foreground">
            The preview uses the scheduler's cron and timezone rules.
          </p>
        </div>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
      </header>

      {saveError === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {saveError}
        </p>
      )}

      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Work to run" error={errors.instruction}>
          <Textarea
            required
            rows={4}
            maxLength={10_000}
            value={values.instruction}
            invalid={errors.instruction !== undefined}
            placeholder="Summarise the inbox and flag anything urgent."
            onChange={(event) => change("instruction", event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Field
            label="Cron expression"
            hint="Five fields: minute hour day-of-month month day-of-week"
            error={errors.cron}
          >
            <Input
              required
              maxLength={200}
              value={values.cron}
              invalid={errors.cron !== undefined}
              placeholder="0 9 * * 1-5"
              spellCheck={false}
              onChange={(event) => change("cron", event.target.value)}
            />
          </Field>
          <Field
            label="Timezone"
            hint="Use an IANA zone such as UTC or Europe/Lisbon"
            error={errors.timezone}
          >
            <Input
              required
              maxLength={100}
              value={values.timezone}
              invalid={errors.timezone !== undefined}
              placeholder="UTC"
              spellCheck={false}
              onChange={(event) => change("timezone", event.target.value)}
            />
          </Field>
        </div>

        <RoutinePreview preview={preview} timezone={values.timezone} />

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={pending}>
            Save routine
          </Button>
        </div>
      </form>
    </section>
  );
}

function RoutinePreview({
  preview,
  timezone,
}: {
  readonly preview: RoutinePreviewState;
  readonly timezone: string;
}) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby="routine-preview-title">
      <div className="m-0 text-heading">
        <h4 id="routine-preview-title">Next fires</h4>
        {preview.status === "loading" ? (
          <span className="text-muted-foreground">Checking…</span>
        ) : null}
      </div>
      <p className="text-meta text-muted-foreground" role="status" aria-live="polite">
        {preview.status === "idle" ? "Edit the schedule to preview its next fires." : null}
      </p>
      {preview.message === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {preview.message}
        </p>
      )}
      {preview.status === "ready" ? (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {preview.fireTimes.map((fireTime) => (
            <li key={fireTime}>
              <time dateTime={fireTime}>{formatRoutineDate(fireTime, timezone)}</time>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

interface RoutineCardProps {
  readonly botId: string;
  readonly routine: Routine;
  readonly outcomes: readonly RoutineOutcome[];
  readonly pending: boolean;
  readonly testPending: boolean;
  readonly onEdit: (routine: Routine) => void;
  readonly onToggle: (routine: Routine) => void;
  readonly onRemove: (routine: Routine) => void;
  readonly onTestRun: (routine: Routine, clientNonce: string) => Promise<RoutineTestRunResult>;
}

function RoutineCard({
  botId,
  routine,
  outcomes,
  pending,
  testPending,
  onEdit,
  onToggle,
  onRemove,
  onTestRun,
}: RoutineCardProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [testRun, setTestRun] = useState<RoutineTestRunResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const lastOutcome = outcomes[0];

  async function runTest(): Promise<void> {
    setTestError(null);

    try {
      setTestRun(await onTestRun(routine, routineTestRunNonce()));
    } catch {
      setTestError("The test run could not be started. Try again.");
    }
  }

  return (
    <Card as="li" className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="m-0 text-heading">
          <h3>{routine.instruction}</h3>
          <p className="text-meta text-muted-foreground">
            {describeRoutineSchedule(routine.cron, routine.timezone)}
          </p>
        </div>
        <Badge tone={routine.enabled ? "success" : "neutral"}>
          {routine.enabled ? "Enabled" : "Paused"}
        </Badge>
      </div>

      <dl className="m-0 break-words text-body">
        <dt>Next fire</dt>
        <dd>
          {routine.enabled ? (
            <time dateTime={routine.nextRunAt}>
              {formatRoutineDate(routine.nextRunAt, routine.timezone)}
            </time>
          ) : (
            <span className="text-muted-foreground">Paused</span>
          )}
        </dd>
        <dt>Last outcome</dt>
        <dd>
          {lastOutcome === undefined ? (
            <span className="text-muted-foreground">No scheduled runs yet</span>
          ) : (
            <OutcomeSummary outcome={lastOutcome} timezone={routine.timezone} />
          )}
        </dd>
      </dl>

      {testError === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {testError}
        </p>
      )}
      {testRun === null ? null : (
        <p
          className="m-0 rounded-md border border-border bg-background p-2 font-mono text-code"
          role="status"
        >
          Test run started.{" "}
          <a href={threadPath(botId, testRun.threadId, testRun.runId)}>Open the test run</a>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={() => onEdit(routine)}>
          Edit
        </Button>
        <Button disabled={pending} onClick={() => onToggle(routine)}>
          {routine.enabled ? "Pause" : "Re-enable"}
        </Button>
        <Button loading={testPending} disabled={pending} onClick={() => void runTest()}>
          Test run
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={() => {
            setConfirmingRemove(!confirmingRemove);
          }}
        >
          {confirmingRemove ? "Cancel" : "Remove"}
        </Button>
      </div>

      {confirmingRemove ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive bg-card p-2">
          <p>
            Remove this routine? Future fires will stop, and its occurrence history will stay
            available.
          </p>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onRemove(routine);
              setConfirmingRemove(false);
            }}
          >
            Remove routine
          </Button>
        </div>
      ) : null}

      <RoutineLedger botId={botId} routine={routine} outcomes={outcomes} />
    </Card>
  );
}

function RoutineLedger({
  botId,
  routine,
  outcomes,
}: {
  readonly botId: string;
  readonly routine: Routine;
  readonly outcomes: readonly RoutineOutcome[];
}) {
  return (
    <details className="m-0 flex list-none flex-col gap-2 p-0">
      <summary>
        <span>Occurrence ledger</span>
        <span className="text-muted-foreground">{String(outcomes.length)} recorded</span>
      </summary>
      {outcomes.length === 0 ? (
        <p className="text-muted-foreground">No scheduled slots have settled yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {outcomes.map((outcome) => (
            <li key={outcome.occurrenceId} className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <time dateTime={outcome.scheduledFor}>
                  {formatRoutineDate(outcome.scheduledFor, routine.timezone)}
                </time>
                <Badge tone={outcomeTone(outcome.status)}>
                  {routineOutcomeLabel(outcome.status)}
                </Badge>
              </div>
              {outcome.runId === null ? (
                <span className="text-muted-foreground">No run was created for this slot.</span>
              ) : (
                <a href={threadPath(botId, routine.threadId, outcome.runId)}>
                  Open run {outcome.runId}
                </a>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

function OutcomeSummary({
  outcome,
  timezone,
}: {
  readonly outcome: RoutineOutcome;
  readonly timezone: string;
}): ReactNode {
  return (
    <span className="m-0 break-words text-body">
      <Badge tone={outcomeTone(outcome.status)}>{routineOutcomeLabel(outcome.status)}</Badge>{" "}
      <time dateTime={outcome.scheduledFor}>
        {formatRoutineDate(outcome.scheduledFor, timezone)}
      </time>
    </span>
  );
}

function outcomeTone(
  status: RoutineOutcome["status"],
): "success" | "destructive" | "warning" | "info" | "neutral" {
  switch (status) {
    case "success":
      return "success";
    case "failure":
      return "destructive";
    case "cancelled":
      return "warning";
    case "running":
      return "info";
    case "missed":
      return "neutral";
  }
}

function formatRoutineDate(value: string, timezone?: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  try {
    return date.toLocaleString(
      undefined,
      timezone === undefined ? undefined : { timeZone: timezone },
    );
  } catch {
    return date.toLocaleString();
  }
}

function threadPath(botId: string, threadId: string, runId: string): string {
  return `/bots/${encodeURIComponent(botId)}/threads/${encodeURIComponent(threadId)}?run=${encodeURIComponent(runId)}`;
}
