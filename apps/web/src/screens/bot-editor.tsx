import { avatarContentTypes, maxAvatarBytes } from "@porkbot/contracts";
import { srgbAccent } from "@porkbot/tokens";
import { BotAvatar, Button, Field, Input, Select, Textarea } from "@porkbot/ui";
import { useState } from "react";
import { cn } from "../lib/cn.ts";
import type { AvatarContentType, Bot, BotSection, ComputerView } from "@porkbot/contracts";
import { formFromBot, validateBotForm } from "../bots.ts";
import type { BotFormErrors, BotFormValues, ComputerHealth } from "../bots.ts";

export interface BotEditorScreenProps {
  readonly bot: Bot | null;
  readonly sections: readonly BotSection[];
  readonly avatarUrl: string | null;
  readonly computer: ComputerHealth | null;
  readonly pending: boolean;
  readonly notice: string | null;
  readonly onSave: (values: BotFormValues) => Promise<boolean>;
  readonly onCreateSection: (name: string) => Promise<BotSection | null>;
  readonly onAvatar: (file: File & { readonly type: AvatarContentType }) => Promise<void>;
  readonly onClearAvatar: () => Promise<void>;
  readonly onComputer: (action: "boot" | "stop" | "recover") => Promise<ComputerView | null>;
  readonly onArchive: () => Promise<void>;
  readonly onRestore: () => Promise<void>;
}

export function BotEditorScreen(props: BotEditorScreenProps) {
  const [values, setValues] = useState<BotFormValues>(() =>
    props.bot === null
      ? {
          name: "",
          title: "",
          description: "",
          instructions: "",
          color: srgbAccent,
          sectionId: "",
          computerProvider: "",
        }
      : formFromBot(props.bot),
  );
  const [errors, setErrors] = useState<BotFormErrors>({});
  const [newSection, setNewSection] = useState("");
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const editing = props.bot !== null;
  const archived = props.bot !== null && props.bot.archivedAt !== null;
  const previewName = values.name.trim() || "New bot";
  const previewId = props.bot?.id ?? "new-bot-preview";

  function field<Key extends keyof BotFormValues>(key: Key, value: BotFormValues[Key]): void {
    setValues({ ...values, [key]: value });
    setErrors({ ...errors, [key]: undefined });
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3 gap-4">
      <header className="flex flex-col gap-1">
        <div>
          <h2>{editing ? props.bot.name : "New bot"}</h2>
          <p className="text-muted-foreground">
            {editing ? "Profile and runtime settings" : "Set up a teammate"}
          </p>
        </div>
        {archived ? (
          <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-meta bg-destructive/14 text-destructive border-destructive/40">
            Archived
          </span>
        ) : null}
      </header>

      {props.notice === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {props.notice}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <h3>Avatar</h3>
        <div className="flex items-center gap-3">
          <BotAvatar
            id={previewId}
            name={previewName}
            color={values.color}
            imageUrl={props.avatarUrl}
            size={40}
          />
          <div className="flex flex-col gap-1">
            <strong>{previewName}</strong>
            <p className="text-muted-foreground">
              {props.avatarUrl === null
                ? "Generated from this bot’s id and colour."
                : "Your uploaded avatar appears in the roster."}
            </p>
          </div>
          {editing ? (
            <div className="flex flex-wrap gap-2">
              <Field
                label="Upload image"
                className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-transparent bg-transparent text-body hover:bg-accent"
                error={avatarError ?? undefined}
              >
                <Input
                  type="file"
                  accept={avatarContentTypes.join(",")}
                  disabled={props.pending}
                  onChange={(event) => {
                    const file = event.target.files?.[0];

                    if (file === undefined) return;
                    if (!avatarContentTypes.some((type) => type === file.type)) {
                      setAvatarError("Choose a PNG, JPEG, WebP or GIF image.");
                      return;
                    }
                    if (file.size > maxAvatarBytes) {
                      setAvatarError("Choose an image no larger than 512 KB.");
                      return;
                    }

                    setAvatarError(null);
                    void props.onAvatar(file as File & { readonly type: AvatarContentType });
                  }}
                />
              </Field>
              {props.avatarUrl === null ? null : (
                <Button disabled={props.pending} onClick={() => void props.onClearAvatar()}>
                  Remove
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </section>

      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const nextErrors = validateBotForm(values);
          setErrors(nextErrors);
          if (Object.keys(nextErrors).length === 0) void props.onSave(values);
        }}
      >
        <section className="flex flex-col gap-3">
          <h3>Identity</h3>
          <Field label="Name" error={errors.name}>
            <Input
              value={values.name}
              maxLength={201}
              aria-invalid={errors.name === undefined ? undefined : true}
              onChange={(event) => field("name", event.target.value)}
            />
          </Field>
          <Field label="Title" error={errors.title}>
            <Input
              value={values.title}
              maxLength={201}
              aria-invalid={errors.title === undefined ? undefined : true}
              onChange={(event) => field("title", event.target.value)}
            />
          </Field>
          <Field label="Description" error={errors.description}>
            <Textarea
              rows={3}
              value={values.description}
              aria-invalid={errors.description === undefined ? undefined : true}
              onChange={(event) => field("description", event.target.value)}
            />
          </Field>
          <Field label="Colour" className="flex items-center gap-2" error={errors.color}>
            <Input
              type="color"
              value={values.color}
              aria-invalid={errors.color === undefined ? undefined : true}
              onChange={(event) => field("color", event.target.value)}
            />
          </Field>
        </section>

        <section className="flex flex-col gap-3">
          <h3>Instructions</h3>
          <Field label="What should this bot do?" error={errors.instructions}>
            <Textarea
              rows={10}
              value={values.instructions}
              aria-invalid={errors.instructions === undefined ? undefined : true}
              onChange={(event) => field("instructions", event.target.value)}
            />
          </Field>
        </section>

        <section className="flex flex-col gap-3">
          <h3>Section</h3>
          <Field label="Group">
            <Select
              value={values.sectionId}
              onChange={(event) => field("sectionId", event.target.value)}
            >
              <option value="">Unfiled</option>
              {props.sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Field label="New section">
              <Input value={newSection} onChange={(event) => setNewSection(event.target.value)} />
            </Field>
            <Button
              disabled={props.pending || newSection.trim().length === 0}
              onClick={() => {
                void props.onCreateSection(newSection.trim()).then((section) => {
                  if (section !== null) {
                    setNewSection("");
                    field("sectionId", section.id);
                  }
                });
              }}
            >
              Add section
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h3>Computer</h3>
          <Field label="Provider" error={errors.computerProvider}>
            <Input
              value={values.computerProvider}
              placeholder="Deployment default"
              aria-invalid={errors.computerProvider === undefined ? undefined : true}
              onChange={(event) => field("computerProvider", event.target.value)}
            />
          </Field>
          {editing && props.computer !== null ? (
            <ComputerControls
              health={props.computer}
              pending={props.pending}
              onComputer={props.onComputer}
            />
          ) : (
            <p className="text-muted-foreground">
              Computer controls are available after the bot is created.
            </p>
          )}
        </section>

        <div className="self-start">
          <Button type="submit" variant="primary" disabled={props.pending}>
            {props.pending ? "Saving…" : editing ? "Save changes" : "Create bot"}
          </Button>
        </div>
      </form>

      {editing ? (
        <section className="flex flex-col gap-3 gap-2 border-t border-border pt-3">
          <h3>{archived ? "Restore" : "Archive"}</h3>
          <p className="text-muted-foreground">
            {archived
              ? "Restore this bot to make it active again."
              : "Archiving hides this bot but keeps its settings and threads."}
          </p>
          <Button disabled={props.pending} onClick={() => setConfirmingArchive(!confirmingArchive)}>
            {confirmingArchive ? "Cancel" : archived ? "Restore bot" : "Archive bot"}
          </Button>
          {confirmingArchive ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-muted-foreground">Confirm this change?</p>
              <Button
                variant="primary"
                disabled={props.pending}
                onClick={() => void (archived ? props.onRestore() : props.onArchive())}
              >
                {archived ? "Confirm restore" : "Confirm archive"}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}

function ComputerControls({
  health,
  pending,
  onComputer,
}: Readonly<{
  health: ComputerHealth;
  pending: boolean;
  onComputer: BotEditorScreenProps["onComputer"];
}>) {
  if (health.kind === "failed") {
    return (
      <div className="inline-flex items-center gap-1 text-meta text-muted-foreground text-destructive">
        <p>Computer status is unavailable.</p>
        <Button disabled={pending} onClick={() => void onComputer("recover")}>
          Recover
        </Button>
      </div>
    );
  }

  const { view } = health;
  const running = view.assigned && view.state === "running";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 text-meta text-muted-foreground",
        health.kind === "stopped" && "text-destructive",
      )}
    >
      <p>{!view.assigned ? "No computer assigned" : `Computer ${view.state}`}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || running} onClick={() => void onComputer("boot")}>
          Start
        </Button>
        <Button disabled={pending || !running} onClick={() => void onComputer("stop")}>
          Stop
        </Button>
        <Button disabled={pending} onClick={() => void onComputer("recover")}>
          Recover
        </Button>
      </div>
    </div>
  );
}
