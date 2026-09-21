import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { BotSection } from "@porkbot/contracts";
import { formToWriteInput } from "../../bots.ts";
import type { BotFormValues } from "../../bots.ts";
import { BotEditorScreen } from "../../screens/bot-editor.tsx";
import { BotEditorSkeleton } from "../../screens/loading.tsx";

export const Route = createFileRoute("/_app/bots/new")({
  pendingComponent: BotEditorSkeleton,
  loader: ({ context }) => context.bots.listSections(),
  component: NewBotRoute,
});

function NewBotRoute() {
  const loadedSections = Route.useLoaderData();
  const { bots } = Route.useRouteContext();
  const navigate = useNavigate();
  const [sections, setSections] = useState<readonly BotSection[]>(loadedSections);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(values: BotFormValues): Promise<boolean> {
    setPending(true);
    setNotice(null);

    try {
      const bot = await bots.createBot({
        ...formToWriteInput(values),
        spawnKey: crypto.randomUUID(),
      });
      await navigate({ to: "/bots/$botId/edit", params: { botId: bot.id } });
      return true;
    } catch {
      setNotice("The bot could not be created. Check the fields and try again.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function createSection(name: string): Promise<BotSection | null> {
    setPending(true);
    setNotice(null);

    try {
      const section = await bots.createSection(name);
      setSections([...sections, section]);
      return section;
    } catch {
      setNotice("That section could not be added. Choose another name and try again.");
      return null;
    } finally {
      setPending(false);
    }
  }

  return (
    <BotEditorScreen
      bot={null}
      sections={sections}
      avatarUrl={null}
      computer={null}
      pending={pending}
      notice={notice}
      onSave={save}
      onCreateSection={createSection}
      onAvatar={async () => undefined}
      onClearAvatar={async () => undefined}
      onComputer={async () => null}
      onArchive={async () => undefined}
      onRestore={async () => undefined}
    />
  );
}
