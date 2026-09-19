import { avatarContentTypes, maxAvatarBytes } from "@porkbot/contracts";
import { colors } from "@porkbot/tokens";
import { Button } from "@porkbot/ui";
import { useState } from "react";
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
          color: colors.accent,
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

  function field<Key extends keyof BotFormValues>(key: Key, value: BotFormValues[Key]): void {
    setValues({ ...values, [key]: value });
    setErrors({ ...errors, [key]: undefined });
  }

  return (
    <section className="console bot-editor">
      <header className="memory-header">
        <div>
          <h2>{editing ? props.bot.name : "New bot"}</h2>
          <p className="muted">{editing ? "Profile and runtime settings" : "Set up a teammate"}</p>
        </div>
        {archived ? <span className="bot-status bot-status-stopped">Archived</span> : null}
      </header>

      {props.notice === null ? null : (
        <p className="form-error" role="alert">
          {props.notice}
        </p>
      )}

      {editing ? (
        <section className="editor-section">
          <h3>Avatar</h3>
          <div className="avatar-editor">
            {props.avatarUrl === null ? (
              <span className="bot-avatar bot-avatar-large" aria-label="No avatar">
                {initials(props.bot.name)}
              </span>
            ) : (
              <img className="bot-avatar bot-avatar-large" src={props.avatarUrl} alt="" />
            )}
            <div className="bot-actions">
              <label className="file-button">
                Upload image
                <input
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
              </label>
              {props.avatarUrl === null ? null : (
                <Button disabled={props.pending} onClick={() => void props.onClearAvatar()}>
                  Remove
                </Button>
              )}
            </div>
          </div>
          {avatarError === null ? null : (
            <p className="field-error" role="alert">
              {avatarError}
            </p>
          )}
        </section>
      ) : null}

      <form
        className="editor-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          const nextErrors = validateBotForm(values);
          setErrors(nextErrors);
          if (Object.keys(nextErrors).length === 0) void props.onSave(values);
        }}
      >
        <section className="editor-section">
          <h3>Identity</h3>
          <label className="field">
            <span>Name</span>
            <input
              value={values.name}
              maxLength={201}
              aria-invalid={errors.name === undefined ? undefined : true}
              onChange={(event) => field("name", event.target.value)}
            />
            <FieldError error={errors.name} />
          </label>
          <label className="field">
            <span>Title</span>
            <input
              value={values.title}
              maxLength={201}
              aria-invalid={errors.title === undefined ? undefined : true}
              onChange={(event) => field("title", event.target.value)}
            />
            <FieldError error={errors.title} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea
              rows={3}
              value={values.description}
              aria-invalid={errors.description === undefined ? undefined : true}
              onChange={(event) => field("description", event.target.value)}
            />
            <FieldError error={errors.description} />
          </label>
          <label className="field color-field">
            <span>Colour</span>
            <input
              type="color"
              value={values.color}
              aria-invalid={errors.color === undefined ? undefined : true}
              onChange={(event) => field("color", event.target.value)}
            />
            <FieldError error={errors.color} />
          </label>
        </section>

        <section className="editor-section">
          <h3>Instructions</h3>
          <label className="field">
            <span>What should this bot do?</span>
            <textarea
              rows={10}
              value={values.instructions}
              aria-invalid={errors.instructions === undefined ? undefined : true}
              onChange={(event) => field("instructions", event.target.value)}
            />
            <FieldError error={errors.instructions} />
          </label>
        </section>

        <section className="editor-section">
          <h3>Section</h3>
          <label className="field">
            <span>Group</span>
            <select
              value={values.sectionId}
              onChange={(event) => field("sectionId", event.target.value)}
            >
              <option value="">Unfiled</option>
              {props.sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name}
                </option>
              ))}
            </select>
          </label>
          <div className="inline-form">
            <label className="field">
              <span>New section</span>
              <input value={newSection} onChange={(event) => setNewSection(event.target.value)} />
            </label>
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

        <section className="editor-section">
          <h3>Computer</h3>
          <label className="field">
            <span>Provider</span>
            <input
              value={values.computerProvider}
              placeholder="Deployment default"
              aria-invalid={errors.computerProvider === undefined ? undefined : true}
              onChange={(event) => field("computerProvider", event.target.value)}
            />
            <FieldError error={errors.computerProvider} />
          </label>
          {editing && props.computer !== null ? (
            <ComputerControls
              health={props.computer}
              pending={props.pending}
              onComputer={props.onComputer}
            />
          ) : (
            <p className="muted">Computer controls are available after the bot is created.</p>
          )}
        </section>

        <div className="editor-save">
          <Button type="submit" tone="primary" disabled={props.pending}>
            {props.pending ? "Saving…" : editing ? "Save changes" : "Create bot"}
          </Button>
        </div>
      </form>

      {editing ? (
        <section className="editor-section archive-section">
          <h3>{archived ? "Restore" : "Archive"}</h3>
          <p className="muted">
            {archived
              ? "Restore this bot to make it active again."
              : "Archiving hides this bot but keeps its settings and threads."}
          </p>
          <Button disabled={props.pending} onClick={() => setConfirmingArchive(!confirmingArchive)}>
            {confirmingArchive ? "Cancel" : archived ? "Restore bot" : "Archive bot"}
          </Button>
          {confirmingArchive ? (
            <div className="confirm-row">
              <p className="muted">Confirm this change?</p>
              <Button
                tone="primary"
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
      <div className="computer-state computer-state-failed">
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
    <div className={`computer-state ${health.kind === "stopped" ? "computer-state-failed" : ""}`}>
      <p>{!view.assigned ? "No computer assigned" : `Computer ${view.state}`}</p>
      <div className="bot-actions">
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

function FieldError({ error }: Readonly<{ error: string | undefined }>) {
  return error === undefined ? null : (
    <span className="field-error" role="alert">
      {error}
    </span>
  );
}

function initials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
