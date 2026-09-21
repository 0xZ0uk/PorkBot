import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { Button } from "@porkbot/ui";
import { useCallback, useRef, useState } from "react";
import type { Routine } from "@porkbot/contracts";
import { RoutinesScreen } from "../../screens/routines.tsx";
import type {
  RoutinePreviewState,
  RoutineScheduleInput,
  RoutineTestRunResult,
  RoutineUpdateInput,
  RoutinesTransport,
} from "../../routines.ts";
import { routineScheduleErrorMessage } from "../../routines.ts";

/**
 * The selected bot's routine screen. The loader reads the live rows and their
 * ledgers together, so a card can show its last outcome without a client-side
 * guess. Writes go through the transport and invalidate the same loader, which
 * keeps the next-fire cursor and the occurrence history server-authored.
 */
export const Route = createFileRoute("/_app/bots/$botId/routines")({
  loader: async ({ context, params }) => {
    if (context.routines === undefined) {
      throw new Error("the routines transport is not configured");
    }

    return readRoutines(context.routines, params.botId);
  },
  component: RoutinesRoute,
  errorComponent: RoutinesUnavailable,
});

async function readRoutines(transport: RoutinesTransport, botId: string) {
  const routines = await transport.list(botId);
  const ledgerEntries = await Promise.all(
    routines.map(
      async (routine) =>
        [routine.id, await transport.outcomes({ id: routine.id, limit: 20 })] as const,
    ),
  );

  return { routines, outcomes: Object.fromEntries(ledgerEntries) };
}

function RoutinesRoute() {
  const { botId } = Route.useParams();
  const { routines: transport } = Route.useRouteContext();
  const { routines, outcomes } = Route.useLoaderData();
  const routineTransport = transport;
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<RoutinePreviewState>({
    status: "idle",
    fireTimes: [],
    message: null,
  });
  const previewGeneration = useRef(0);

  const previewSchedule = useCallback(
    (input: { readonly cron: string; readonly timezone: string; readonly count: number }): void => {
      const generation = ++previewGeneration.current;

      if (input.cron.trim() === "" || input.timezone.trim() === "") {
        setPreview({ status: "idle", fireTimes: [], message: null });
        return;
      }

      if (routineTransport === undefined) {
        setPreview({
          status: "refused",
          fireTimes: [],
          message: "Routines could not be loaded.",
        });
        return;
      }

      setPreview({ status: "loading", fireTimes: [], message: null });
      void routineTransport
        .preview(input)
        .then((fireTimes) => {
          if (generation === previewGeneration.current) {
            setPreview({ status: "ready", fireTimes, message: null });
          }
        })
        .catch((error: unknown) => {
          if (generation === previewGeneration.current) {
            setPreview({
              status: "refused",
              fireTimes: [],
              message:
                routineScheduleErrorMessage(input.cron, input.timezone, error) ??
                "The scheduler could not resolve this schedule. Choose another time or timezone.",
            });
          }
        });
    },
    [routineTransport],
  );

  if (routineTransport === undefined) {
    return <RoutinesUnavailable reset={() => undefined} />;
  }

  const api = routineTransport;

  function openCreate(): void {
    setNotice(null);
    setEditingRoutineId(null);
    setCreating(true);
  }

  function openEdit(routine: Routine): void {
    setNotice(null);
    setCreating(false);
    setEditingRoutineId(routine.id);
  }

  function closeEditor(): void {
    setCreating(false);
    setEditingRoutineId(null);
    setPreview({ status: "idle", fireTimes: [], message: null });
  }

  async function create(
    input: RoutineScheduleInput & { readonly botId: string },
  ): Promise<boolean> {
    setPending("create");
    setNotice(null);

    try {
      await api.create(input);
      await router.invalidate();
      return true;
    } catch (error) {
      setNotice(
        routineScheduleErrorMessage(input.cron, input.timezone, error) ??
          "The routine could not be created. Check the fields and try again.",
      );
      return false;
    } finally {
      setPending(null);
    }
  }

  async function update(input: RoutineUpdateInput): Promise<boolean> {
    setPending(`save:${input.id}`);
    setNotice(null);

    try {
      await api.update(input);
      await router.invalidate();
      return true;
    } catch (error) {
      setNotice(
        input.cron === undefined || input.timezone === undefined
          ? "The routine could not be saved. Try again."
          : (routineScheduleErrorMessage(input.cron, input.timezone, error) ??
              "The routine could not be saved. Check the schedule and try again."),
      );
      return false;
    } finally {
      setPending(null);
    }
  }

  function toggle(routine: Routine): void {
    setPending(`toggle:${routine.id}`);
    setNotice(null);
    void api
      .update({ id: routine.id, enabled: !routine.enabled })
      .then(() => router.invalidate())
      .catch(() => {
        setNotice("The routine could not be updated. Try again.");
      })
      .finally(() => {
        setPending(null);
      });
  }

  function remove(routine: Routine): void {
    setPending(`remove:${routine.id}`);
    setNotice(null);
    void api
      .remove(routine.id)
      .then(() => router.invalidate())
      .catch(() => {
        setNotice("The routine could not be removed. Try again.");
      })
      .finally(() => {
        setPending(null);
      });
  }

  async function testRun(routine: Routine, clientNonce: string): Promise<RoutineTestRunResult> {
    setPending(`test:${routine.id}`);
    setNotice(null);

    try {
      return await api.testRun({ id: routine.id, clientNonce });
    } catch (error) {
      setNotice("The test run could not be started. Try again.");
      throw error;
    } finally {
      setPending(null);
    }
  }

  return (
    <RoutinesScreen
      botId={botId}
      routines={routines}
      outcomes={outcomes}
      creating={creating}
      editingRoutineId={editingRoutineId}
      pending={pending}
      notice={notice}
      preview={preview}
      onCreateOpen={openCreate}
      onEdit={openEdit}
      onCloseEditor={closeEditor}
      onPreview={previewSchedule}
      onCreate={create}
      onUpdate={update}
      onToggle={toggle}
      onRemove={remove}
      onTestRun={testRun}
    />
  );
}

function RoutinesUnavailable({ reset }: ErrorComponentProps | { readonly reset: () => void }) {
  return (
    <section className="console">
      <p className="form-error" role="alert">
        Routines could not be loaded.
      </p>
      <Button onClick={reset}>Try again</Button>
    </section>
  );
}
