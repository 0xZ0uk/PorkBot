import { Button, Icon } from "@porkbot/ui";
import type { IconName } from "@porkbot/ui";
import { modeLabel, modes } from "./mode.ts";
import type { Mode } from "./mode.ts";
import { useMode } from "./mode-context.tsx";

/**
 * The explicit mode control (slice 13.13; design record, Mode policy): the
 * settings surface's copy of the three-way choice, rendered as a segmented
 * group so the selected mode is visible rather than a two-way toggle that
 * cannot express System. It writes through the shell's mode context, so the
 * rail footer's menu and this control are the same choice.
 */

const modeIcons: Readonly<Record<Mode, IconName>> = {
  system: "monitor",
  light: "sun",
  dark: "moon",
};

export function ModeControl() {
  const { mode, setMode } = useMode();

  return (
    <div className="flex items-center gap-2" data-settings-mode>
      <span className="text-meta font-medium text-muted-foreground" id="settings-mode-label">
        Mode
      </span>
      <div className="inline-flex gap-1" role="group" aria-labelledby="settings-mode-label">
        {modes.map((candidate) => (
          <Button
            key={candidate}
            variant="ghost"
            className="px-2 py-1 text-muted-foreground"
            aria-pressed={candidate === mode}
            onClick={() => {
              setMode(candidate);
            }}
          >
            <Icon name={modeIcons[candidate]} />
            {modeLabel(candidate)}
          </Button>
        ))}
      </div>
    </div>
  );
}
