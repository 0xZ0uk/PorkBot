import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { AvatarContentType, BotSection, ComputerView } from "@porkbot/contracts";
import { formToWriteInput, readComputerHealth } from "../../bots.ts";
import type { BotFormValues } from "../../bots.ts";
import { BotEditorScreen } from "../../screens/bot-editor.tsx";
import { BotEditorSkeleton } from "../../screens/loading.tsx";

export const Route = createFileRoute("/_app/bots/$botId/edit")({
  pendingComponent: BotEditorSkeleton,
  loader: async ({ context, params }) => {
    const [bot, sections, computer] = await Promise.all([
      context.bots.getBot(params.botId),
      context.bots.listSections(),
      readComputerHealth(context.bots, params.botId),
    ]);
    const avatar =
      bot.avatarKey === null ? null : await context.bots.readAvatar(bot.id).catch(() => null);

    return {
      bot,
      sections,
      computer,
      avatarUrl: avatar === null ? null : `data:${avatar.contentType};base64,${avatar.data}`,
    };
  },
  component: EditBotRoute,
});

function EditBotRoute() {
  const loaded = Route.useLoaderData();
  const { bots } = Route.useRouteContext();
  const router = useRouter();
  const [sections, setSections] = useState<readonly BotSection[]>(loaded.sections);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, failure: string): Promise<boolean> {
    setPending(true);
    setNotice(null);

    try {
      await action();
      await router.invalidate();
      return true;
    } catch {
      setNotice(failure);
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

  async function computer(action: "boot" | "stop" | "recover"): Promise<ComputerView | null> {
    const calls = {
      boot: bots.bootComputer,
      stop: bots.stopComputer,
      recover: bots.recoverComputer,
    };
    let answer: ComputerView | null = null;

    await run(async () => {
      answer = await calls[action](loaded.bot.id);
    }, `The computer could not ${action}. Try again.`);
    return answer;
  }

  return (
    <BotEditorScreen
      key={loaded.bot.updatedAt}
      bot={loaded.bot}
      sections={sections}
      avatarUrl={loaded.avatarUrl}
      computer={loaded.computer}
      pending={pending}
      notice={notice}
      onSave={(values: BotFormValues) =>
        run(
          () => bots.updateBot(loaded.bot.id, formToWriteInput(values)),
          "The bot could not be saved. Check the fields and try again.",
        )
      }
      onCreateSection={createSection}
      onAvatar={(file: File & { readonly type: AvatarContentType }) =>
        run(
          async () =>
            bots.setAvatar({
              id: loaded.bot.id,
              contentType: file.type,
              data: await fileBase64(file),
            }),
          "The avatar could not be uploaded. Try another image.",
        ).then(() => undefined)
      }
      onClearAvatar={() =>
        run(
          () => bots.clearAvatar(loaded.bot.id),
          "The avatar could not be removed. Try again.",
        ).then(() => undefined)
      }
      onComputer={computer}
      onArchive={() =>
        run(() => bots.archiveBot(loaded.bot.id), "The bot could not be archived. Try again.").then(
          () => undefined,
        )
      }
      onRestore={() =>
        run(() => bots.restoreBot(loaded.bot.id), "The bot could not be restored. Try again.").then(
          () => undefined,
        )
      }
    />
  );
}

async function fileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
