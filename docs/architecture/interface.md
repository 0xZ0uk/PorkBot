# Interface

This is the direction the interface epic builds against. It was written before
any screen was rebuilt, and it is the thing a later slice shoots at: a slice
that departs from it changes this file in the same pull request, so a
disagreement is a diff and not a taste argument.

The direction synthesises two products the PRD already names. **Grok Bot** is
the commercial comparable: messaging-native grammar, a mascot per teammate, a
full-bleed view of the bot's screen. **Rakazo** is the reference
implementation: a three-pane workspace, monochrome surfaces carrying one
identity colour per bot, and structured work rendered as report cards rather
than prose. Everything below either comes from one of them, from a secondary
comparable named at the decision, or from a fact already in this repository —
and each decision names both its source and its reason.

Three static mocks live at [`interface-mocks/`](interface-mocks/) beside this
record: the roster and a thread at 1280 wide, the same at 390 wide, and the
computer surface with its inspector. They are plain HTML with no framework and
are not shipped; their only job is to settle a question on a screen instead of
in prose. Their captures are committed under `docs/screenshots/interface-*.png`
and are the first entries of the screenshot set that defines done.

## Source register

| Source                    | What it is                             | What we take                                                                                                  | What we leave                                            |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Grok Bot (PRD comparable) | Commercial persistent-teammate product | Messaging-native grammar: bubbles, inline action and approval cards, a mascot per teammate, full-bleed screen | The closed surface, the vendor lock, the chat-only model |
| Rakazo (PRD reference)    | Open-source reconstruction target      | Three-pane shell, monochrome surfaces with one identity colour per bot, structured work as report cards       | The god-file scale, the inherited chrome, the density    |

| Secondary comparable   | Borrowed for                                              |
| ---------------------- | --------------------------------------------------------- |
| Slack, Discord         | Message grouping, attribution and timestamp separators    |
| Linear                 | State chips, restrained motion, a pending count in a rail |
| GitHub Actions, Vercel | The ✓ and → outcome lines of a run report                 |
| VS Code                | The inspector as context beside content, never a modal    |
| iOS, macOS             | A sheet for the narrow layout, window chrome for a screen |
| shadcn/ui              | The theme structure already in `@porkbot/tokens`          |

## Shell anatomy

At 64rem and wider the workspace is three panes: a **rail** (16rem) carrying
search and the roster, a **content pane** carrying the thread or the bot's
computer, and an **inspector** (19rem) carrying the selected bot's context.
The thread column is capped at 44rem inside the content pane; the computer
surface is full-bleed. Below 64rem one pane is visible at a time and a
switcher sheet replaces the rail. Slice 13.4 built this shell and its captures
live under `docs/screenshots/shell-*.png`; the panes' contents arrive with the
slices that own them.

| Decision                                                                                                         | Source                                                   | Reason                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rail, content, inspector — three panes, not a top bar and a centred column                                       | Rakazo's three-pane workspace                            | Reading a thread and watching a bot's state are concurrent needs; a top bar spends its width on navigation and answers neither.                                    |
| Rail is the roster, not a navigation tree; approvals, settings, sign out and the mode control live in its footer | Grok Bot's teammate list; Linear's rail footer           | One operator and a handful of bots: the rail's whole height should answer "who is working", and settings are a single trip, not a permanent pane.                  |
| The inspector is contextual to the selected bot: state, live screen, routines, pending approvals                 | VS Code's inspector; the epic's context inspector        | An approval and a routine outcome are decisions; a decision needs the thread visible beside it, which a modal and a separate page both destroy.                    |
| The inspector collapses and its state survives navigation                                                        | VS Code's toggleable panel                               | On a 1280 screen the thread wants the width; an operator who closed the inspector should not have it reopen on every navigation.                                   |
| The composer is pinned to the content pane's bottom and the approval card never covers it                        | Grok Bot's messaging composer                            | Sending and approving are the two acts the product exists for; neither may be scrolled away or occluded.                                                           |
| One pane at a time below 64rem, with a switcher sheet for the rail and the inspector                             | iOS split-view collapse; Grok Bot's mobile single column | 64rem is where rail plus inspector plus a readable thread stop fitting; a sheet keeps the roster one gesture away without a permanent 17rem tax on a 390px screen. |
| No horizontal scroll at 390; the thread column, bubbles and cards all fit the viewport                           | iOS and Android layout guides                            | A workspace that pans sideways on a phone is a desktop page, not a surface.                                                                                        |
| The header carries identity, state and the pane toggle; the switcher lists the roster and settings               | Grok Bot's conversation header; iOS action sheet         | One control opens one list, so the roster is reachable on a phone without a hamburger drawer that hides the thread.                                                |

## Identity

Every bot is recognisable everywhere it is named. The identity is a
deterministic mascot — a geometric shape with two eyes — plus a hue from an
identity ramp, both derived from the bot's id. The bot's own `color` field
overrides the hue, and an uploaded avatar (`avatarKey`) replaces the mascot
with the image.

| Decision                                                                                                             | Source                                                     | Reason                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A deterministic mascot generated from the bot id, not an asset                                                       | Grok Bot's per-teammate mascot                             | Recognisability with no upload, no network and no asset pipeline; the same id renders the same mascot in the web app and the desktop wrapper because the generator is a pure function. |
| Shape and eye style from the id, hue from a 12-position ramp indexed by the id                                       | Grok Bot's mascots; Rakazo's one identity colour per bot   | 12 hues × 4 shapes × 2 eye styles is enough distinct identities for one operator's roster, so two bots never look alike in the rail.                                                   |
| The identity ramp holds hue positions, and each mode has its own lightness and chroma                                | shadcn's oklch tokens in `@porkbot/tokens`                 | A hue that reads on near-black is too light on near-white; fixing lightness per mode keeps every identity legible on both surfaces.                                                    |
| `bot.color` overrides the hue; `avatarKey` replaces the mascot                                                       | The bot contract already carries both fields               | The operator's explicit choice wins over the generator, and an uploaded image is a deliberate act.                                                                                     |
| Identity appears in the rail row, thread header, assistant attribution, approval card, inspector and computer chrome | Grok Bot's mascot in message attribution                   | One glance answers "which teammate is this" in every place the bot is named, so the transcript never needs a "Bot" label.                                                              |
| Identity hues are tints; state colours are fills, and state is never carried by colour alone                         | WCAG 1.4.1; Rakazo's monochrome-plus-one-colour discipline | A green mascot and a green success dot cannot be confused when one is a shape and the other is a worded chip; colour alone fails accessibility and a screenshot.                       |

## Conversation grammar

A thread is a conversation, not a document. Turns are bubbles with attribution
and timestamp separators; a run's structured outcome is a report card; a tool
call is one timeline entry; an approval is an inline card at the point the run
parked. The grammar is rendered from the reducer's state, so a reload and a
live stream produce the same screen.

| Decision                                                                                                                                                        | Source                                                          | Reason                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bubbles with speaker alignment, not labelled prose: the operator's turn filled and end-aligned, the bot's on a surface and start-aligned                        | Grok Bot's messaging grammar; iMessage                          | Alignment carries the speaker, so the transcript stops repeating "You" and the bot's name; labels are reserved for the places identity is not already visible. |
| The operator's word stays in the DOM for assistive technology even where it is not painted                                                                      | WCAG 1.3.1 and 1.4.1                                            | Alignment is not available to a screen reader; the fill and the position may carry the speaker for a sighted reader, but the word is what a reader hears.      |
| Consecutive turns from one speaker within five minutes share one attribution block; a longer gap or a run start gets a timestamp separator                      | Slack's message grouping                                        | A long run emits many assistant turns; one attribution per turn is noise, and a run boundary is the separator that matters.                                    |
| The transcript opens on its newest turn, follows a streaming run while the reader is at the bottom, and offers a jump-to-latest control once they scroll away   | Grok Bot's anchored transcript; iOS chat scroll behaviour       | A live run appends faster than a person scrolls; anchoring keeps the newest work visible without yanking a reader who went back to read earlier turns.         |
| Attachments and artifacts are cards inside the bubble, with name, type, size and one open or download action                                                    | Grok Bot's inline attachment cards                              | A URL in prose is a dead end; the artifact's metadata is the useful part and the card survives a re-render.                                                    |
| A run's outcome is a report card of ✓ lines (done) and → lines (handed off or followed up), rendered from the run's own events                                  | GitHub Actions and Vercel logs; Rakazo's report cards           | Prose hides what finished; a card is scannable, and it is testable because it is derived from events rather than parsed from a summary.                        |
| A tool call is one timeline entry — tool, one-line target, duration, outcome — that expands into the arguments and result the timeline already renders          | Rakazo's structured work; the existing tool-call timeline       | The timeline is the audit trail; the detail already exists and moves behind one disclosure instead of sitting beside the transcript as a JSON dump.            |
| An approval is an inline card in the transcript where the run parked, mirrored in the inspector: consequence, tool and target, deadline, Approve and Deny pills | Grok Bot's inline approval cards; the existing approvals screen | An approval is a decision in the run's own story; a separate inbox hides the context the decision needs, and the queue still exists for the history.           |
| The composer is one text area plus attachments; sending while a run is active steers it, and Stop is a separate control                                         | Grok Bot's steer-by-message; PRD story 20                       | Steering is just talking; a mode switch would make the common act harder, and Stop is destructive enough to deserve its own target.                            |
| No raw JSON in the transcript and no state sentences: detail lives behind a disclosure, state lives in the vocabulary below                                     | The epic's diagnosis of the current surface                     | JSON beside prose is two answers to one question, and "The machine is running." is a sentence where a chip belongs.                                            |

Slice 13.7 built this grammar and its captures — a streaming run, an attachment
and an upload failure, both modes — live under
`docs/screenshots/conversation-*.png`.

## State vocabulary

One vocabulary, one visual each. The words are the operator's; the mapping to
the run's own statuses and to `assessRunLiveness` is fixed here so the rail,
the thread header, the inspector and a notification cannot disagree.

| State           | Internal source                                                              | Visual                                                                        |
| --------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| idle            | No active run; a completed run returns the bot here                          | Hollow dot, muted word                                                        |
| working         | `starting`, `thinking`, `working` liveness                                   | Filled dot in the identity hue with the ambient pulse                         |
| waiting for you | `waiting_approval` status or `waiting` liveness                              | Filled dot in the accent, plus a count badge in the rail and the inspector    |
| stuck           | `stuck` liveness                                                             | Filled dot in the warning colour with a static ring; no pulse                 |
| failed          | The last run `failed`                                                        | Filled dot in the destructive colour; the failure's one line in the inspector |
| stopped         | A run `cancelled` by the operator, or `stopping` while the stop is in flight | Hollow dot with a horizontal bar                                              |

| Decision                                                                                        | Source                                                                            | Reason                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Six words, not the run's internal statuses                                                      | `run-liveness.ts` already separates the operator's question from the row's fields | The operator asks "what should I do"; queued, running, waiting_approval, completed, failed and cancelled are the machine's answers, not theirs. |
| A completed run returns the bot to idle and closes the thread with its report card              | Linear's completed states; the report card above                                  | "Done" is not a state that needs attention; the outcome belongs to the thread, and the chip should answer what is happening now.                |
| "Waiting for you" is the loudest thing on the screen: the only accent fill, the only rail badge | Linear's inbox count; the epic's loudest-state rule                               | It is the only state where the run cannot proceed without the operator, and it is the one the product exists to surface.                        |
| The rail never reorders by state; a count badge carries the attention instead                   | Linear's inbox; Slack's unread badge                                              | Reordering a list under a reader's cursor is worse than a badge, and a bot's position is part of how the operator finds it.                     |
| State is a dot plus a word, never a colour alone, and a screen reader gets the word             | WCAG 1.4.1                                                                        | Colour-only state fails accessibility and cannot be asserted from a screenshot; the word is what a test and a reader both read.                 |

## Scales

The token set landed in `@porkbot/tokens` in slice 13.2 and the register builds
on it in 13.3; a surface writes a token name, never a value, and the
hardcoded-colour lint rule proves the colour half. The palette below is
measured: `packages/tokens/src/index.test.ts` holds the contrast floors and
fails a value that drops below one, so the numbers here are a check rather than
a claim. The mocks in [`interface-mocks/`](interface-mocks/) still carry the
provisional 13.1 values; this table and the token package are the measured set,
and the palette's specimen capture lives under `docs/screenshots/tokens-light.png`
and `docs/screenshots/tokens-dark.png`.

### Palette

The surfaces are monochrome at hue 285, and the mode's lightness is the only
difference between them, so dark mode elevates by surface rather than by shadow.

| Token                   | Light                      | Dark                       | Used for                              |
| ----------------------- | -------------------------- | -------------------------- | ------------------------------------- |
| `--pb-color-background` | `oklch(0.9850 0.0020 285)` | `oklch(0.1600 0.0050 285)` | The page behind the panes             |
| `--pb-color-surface`    | `oklch(1.0000 0 0)`        | `oklch(0.2000 0.0060 285)` | Cards, rail, inspector, bubbles       |
| `--pb-color-raised`     | `oklch(0.9650 0.0030 285)` | `oklch(0.2400 0.0070 285)` | Hover, selected rows, nested surfaces |
| `--pb-color-border`     | `oklch(0.9000 0.0050 285)` | `oklch(0.2900 0.0080 285)` | Separators and control outlines       |
| `--pb-color-foreground` | `oklch(0.2400 0.0100 285)` | `oklch(0.9300 0.0040 285)` | Body text                             |
| `--pb-color-muted`      | `oklch(0.5000 0.0120 285)` | `oklch(0.6800 0.0120 285)` | Timestamps, labels, secondary text    |

The accent is warm — a rose, not the stock blue nobody chose — because the
accent means "your turn" and the state it marks is the one the product is
about. It fills the waiting chip and its badge and is a text colour everywhere
else, so it is measured twice: against the three surfaces it sits on and
against the foreground it carries.

| Token                               | Light                      | Dark                       | Measurement                                         |
| ----------------------------------- | -------------------------- | -------------------------- | --------------------------------------------------- |
| `--pb-color-accent`                 | `oklch(0.5720 0.2345 350)` | `oklch(0.7200 0.2055 350)` | ≥ 4.56:1 light, ≥ 6.00:1 dark on all three surfaces |
| `--pb-color-accent-foreground`      | `oklch(0.9900 0.0040 350)` | `oklch(0.1800 0.0100 350)` | 4.90:1 on the accent, 6.87:1 in dark                |
| `--pb-color-success`                | `oklch(0.5250 0.1422 150)` | `oklch(0.7200 0.1945 150)` | ≥ 4.56:1 light, ≥ 7.16:1 dark                       |
| `--pb-color-warning`                | `oklch(0.5450 0.1132 75)`  | `oklch(0.7200 0.1491 75)`  | ≥ 4.57:1 light, ≥ 6.49:1 dark                       |
| `--pb-color-info`                   | `oklch(0.5370 0.1210 240)` | `oklch(0.7200 0.1595 240)` | ≥ 4.56:1 light, ≥ 6.76:1 dark                       |
| `--pb-color-destructive`            | `oklch(0.5670 0.2238 30)`  | `oklch(0.7200 0.1715 30)`  | ≥ 4.57:1 light, ≥ 6.18:1 dark                       |
| `--pb-color-destructive-foreground` | `oklch(0.9900 0.0040 30)`  | `oklch(0.1800 0.0100 30)`  | 4.91:1 on the destructive, 7.07:1 in dark           |

Every state colour is measured on `--pb-color-background`, `--pb-color-surface`
and `--pb-color-raised`; the table states the tightest of the three. The accent
sits 0.157 (light) and 0.133 (dark) from destructive in OKLab — three times the
ramp's distinctness floor — so "waiting for you" cannot read as a failure, and
warning's amber stays at least 0.12 from both in either mode.

### Identity ramp

The ramp is twelve hues, `15° + 30° × n`, at a fixed lightness per mode: 0.60
light and 0.72 dark. Chroma is the largest the sRGB gamut holds at that
lightness, kept a little inside the boundary and capped at 0.15 (light) and
0.13 (dark) so identity stays a tint rather than a second state colour. The
minimum contrast below is against `--pb-color-raised`, the lightest dark surface
and the darkest light one.

| Position     | Hue | Light                      | Dark                       | Contrast light / dark |
| ------------ | --- | -------------------------- | -------------------------- | --------------------- |
| `identity1`  | 15  | `oklch(0.6000 0.1470 15)`  | `oklch(0.7200 0.1274 15)`  | 3.84 / 6.26           |
| `identity2`  | 45  | `oklch(0.6000 0.1470 45)`  | `oklch(0.7200 0.1274 45)`  | 3.78 / 6.36           |
| `identity3`  | 75  | `oklch(0.6000 0.1244 75)`  | `oklch(0.7200 0.1274 75)`  | 3.64 / 6.52           |
| `identity4`  | 105 | `oklch(0.6000 0.1251 105)` | `oklch(0.7200 0.1274 105)` | 3.52 / 6.72           |
| `identity5`  | 135 | `oklch(0.6000 0.1470 135)` | `oklch(0.7200 0.1274 135)` | 3.39 / 6.92           |
| `identity6`  | 165 | `oklch(0.6000 0.1239 165)` | `oklch(0.7200 0.1274 165)` | 3.35 / 7.03           |
| `identity7`  | 195 | `oklch(0.6000 0.1005 195)` | `oklch(0.7200 0.1205 195)` | 3.40 / 6.99           |
| `identity8`  | 225 | `oklch(0.6000 0.1116 225)` | `oklch(0.7200 0.1274 225)` | 3.46 / 6.85           |
| `identity9`  | 255 | `oklch(0.6000 0.1470 255)` | `oklch(0.7200 0.1274 255)` | 3.59 / 6.64           |
| `identity10` | 285 | `oklch(0.6000 0.1470 285)` | `oklch(0.7200 0.1274 285)` | 3.73 / 6.43           |
| `identity11` | 315 | `oklch(0.6000 0.1470 315)` | `oklch(0.7200 0.1274 315)` | 3.82 / 6.30           |
| `identity12` | 345 | `oklch(0.6000 0.1470 345)` | `oklch(0.7200 0.1274 345)` | 3.86 / 6.25           |

Every hue clears the 3:1 non-text floor on all three surfaces, and the closest
pair of hues is 0.0559 apart in OKLab in light and 0.0645 in dark, above the
0.05 distinctness floor the token test enforces — so two bots in a rail are
never two shades of one colour.

### Type

Each step is three custom properties: `--pb-type-<step>-size`,
`--pb-type-<step>-line-height` and `--pb-type-<step>-weight`.

| Token     | Size / line height   | Weight | Used for                                      |
| --------- | -------------------- | ------ | --------------------------------------------- |
| `display` | 1.5rem / 2rem        | 600    | An empty state's one line                     |
| `title`   | 1.125rem / 1.5rem    | 600    | Pane headers and the thread header's bot name |
| `heading` | 0.9375rem / 1.375rem | 600    | Inspector section headers                     |
| `body`    | 0.875rem / 1.375rem  | 400    | Messages, controls, prose                     |
| `code`    | 0.8125rem / 1.25rem  | 400    | Tool detail, terminal, file preview           |
| `meta`    | 0.75rem / 1rem       | 500    | Timestamps, chip words, labels                |

Body is 14px because a workspace is dense and a messaging surface at 16px
wraps a two-sentence turn into a wall. The source is Grok Bot's message
metrics and the current app's browser defaults; the reason is that 14px with a
1.375 line height holds a comfortable measure at the 44rem column, and `meta`
is a real step rather than the current uppercase treatment of body text. Sizes
descend from `display` to `meta` in declaration order; `code` is the monospace
step between body and meta, not a rank of its own.

### Space

A 4px rhythm, named by size: `2xs` 0.125rem, `xs` 0.25rem, `sm` 0.5rem, `md`
0.75rem, `lg` 1rem, `xl` 1.5rem, `2xl` 2rem, `3xl` 3rem, `4xl` 4rem; each is
the custom property `--pb-space-<name>`. The pre-13.2 tokens were a coarser
subset (`md` was 1rem, `xl` was 2.5rem); 13.2 was the only slice allowed to
move a value, and after it a name means one value everywhere. Source: shadcn's
spacing conventions and the current `packages/tokens`; reason: a dense list
needs a 12px step that did not exist, and a scale with holes invites a literal.

### Radius and elevation

Each radius step is `--pb-radius-<name>` and each elevation level is
`--pb-elevation-<name>`.

| Token  | Value    | Used for                         |
| ------ | -------- | -------------------------------- |
| `sm`   | 0.125rem | The speaker-side bubble corner   |
| `md`   | 0.25rem  | Nested surfaces                  |
| `lg`   | 0.375rem | Buttons, inputs, menu items      |
| `xl`   | 0.625rem | Cards, bubbles, sheets, popovers |
| `pill` | 999px    | Chips, avatars, count badges     |

| Level     | Value                                                    | Used for                       |
| --------- | -------------------------------------------------------- | ------------------------------ |
| `flat`    | none                                                     | The transcript, the rail       |
| `raised`  | 0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10) | Cards, bubbles                 |
| `overlay` | 0 8px 24px rgb(0 0 0 / 0.18)                             | Sheets, menus, dialogs, toasts |

A bubble uses `xl` with the speaker-side corner at `sm`, which is the tail
without drawing one. A nested surface's radius is its parent's minus the gap
between them, so corners stay concentric. Dark mode elevates by surface
lightness, not by shadow. Source: shadcn's radius scale, iOS concentric
corners and Material's elevation; reason: shadows are nearly invisible on a
near-black surface, and a tail drawn as a shape breaks at every width.

### Motion

Each step is `--pb-motion-<name>`.

| Token      | Value                                     |
| ---------- | ----------------------------------------- |
| `instant`  | 0ms                                       |
| `fast`     | 120ms                                     |
| `base`     | 180ms                                     |
| `slow`     | 240ms                                     |
| `standard` | cubic-bezier(0.2, 0, 0, 1)                |
| `exit`     | cubic-bezier(0.4, 0, 1, 1)                |
| `ambient`  | 2000ms, opacity 1 → 0.55 → 1, ease-in-out |

The budget is four motions and one ambient pulse. Allowed: a state chip's
colour and dot (fast), a message entering (base, 4px rise and fade), a sheet
or overlay entering (base; the rail and inspector slide at slow on narrow
screens), and a toast entering (base). The ambient pulse is used only by the
working dot and skeleton blocks. Nothing else animates: no shimmer in the
transcript, no bouncing mascot, no parallax, no spinner outside a button's own
loading state. `prefers-reduced-motion: reduce` drops every duration to
`instant` and removes every transform, leaving opacity changes only. Source:
Linear's restrained transitions and iOS reduce-motion; reason: a workspace
that animates constantly reads as a toy, and a run's state is already a live
signal, so a second one is noise.

## Colour roles

The surfaces are monochrome. Colour is spent on identity and state, and one
accent is reserved for the operator.

| Role        | Rule                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------- |
| accent      | The brand colour and the "waiting for you" fill and badge; primary buttons; never decoration |
| success     | A ✓ line and a completed outcome; never a bot's identity                                     |
| warning     | Stuck, and a destructive consequence's caution; never a normal state                         |
| destructive | A failed run and destructive actions                                                         |
| info        | Connection and availability facts; never a state chip                                        |
| identity    | A 12-position ramp at fixed lightness per mode; tints only, never text on the surface        |

The accent is warm — a rose rather than the stock blue nobody chose — because
the accent means "your turn" and the state it marks is the one the product is
about. It must stay distinguishable from destructive red and warning amber in
both modes; 13.2 measured every value against the three surfaces and the
foregrounds it carries, and the palette tables above hold the numbers. Source:
Rakazo's monochrome-plus-one-colour discipline and shadcn's token roles;
reason: when identity already owns the spectrum, an accent that also decorates
leaves nothing to mean "attention".

## Mode policy

Dark is the default for a new deployment, light is first-class, and the mode
is an explicit choice: System, Light or Dark, stored per browser in
`localStorage` under `porkbot.theme`. Until a choice is made the system
preference decides; after it, the choice wins. `themeStyleSheet` in
`@porkbot/tokens` declares light on `:root` and dark behind the media query,
then repeats both as `[data-theme="light"]` and `[data-theme="dark"]` after the
media query, so an explicit choice wins by source order. `themeBootstrapScript`
reads the stored key and sets `data-theme` before the bundle runs, so there is
no flash and no OS override of a deliberate choice; the shell's interim
light/dark toggle (slice 13.4) writes the key, and slice 13.13 replaces it with
the explicit System, Light, Dark control.

Source: the current `theme.ts` and shadcn's `.dark` class convention. Reason:
one operator, one device preference, and a choice that a nighttime OS schedule
silently reverses is not a choice. The mode control lives in the rail footer
at 64rem and in the switcher sheet below it.

## Anti-goals

| Anti-goal                                                 | Why                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| No second navigation tree                                 | The rail is the roster and settings is one entry; a tree would spend the rail on navigation the shell already answers.       |
| No raw JSON in the transcript                             | The tool entry's disclosure holds the detail; two renderings of one fact drift apart.                                        |
| No state sentences                                        | The vocabulary above is the whole of it; a sentence per surface is how the current app came to say "The machine is running." |
| No per-screen chrome                                      | A screen composes the register, and hand-rolling is the bug the check in 13.3 exists to catch.                               |
| No colour, space, radius or duration literal in a surface | A literal is a theme change that misses a screen; the lint rule already proves the colour half.                              |
| No mascot animation as a load signal                      | The state chip is the signal, and a mascot that moves while idle reads as work that is not happening.                        |
| No gradients, glass or glow                               | Monochrome surfaces and one identity hue; decoration spends the contrast the identity and state colours need.                |
| No modal where an inline card or a sheet will do          | Approvals are inline and the provider picker and switcher are sheets; a modal hides the context a decision needs.            |
| No infinite scroll in a thread                            | The transcript reads forward pages with an explicit control, because a cursor is not a reading position.                     |
| No emoji as interface icons                               | One icon set, added in 13.3 with its reason; emoji render differently on every platform and carry tone we do not mean.       |

## Component register

Slice 13.3 landed the primitives in `@porkbot/ui`; this record names them and
the composites the shell builds from them, so a later slice knows what exists
before it writes chrome. The register's stylesheet is
`registerStyleSheet` in `@porkbot/ui` and the web shell inlines it beside the
tokens' sheet, so the states below are CSS rules over `--pb-*` properties rather
than per-screen styling; `packages/ui/src/style-sheet.test.tsx` fails on a
colour literal and on a class the sheet does not draw. The icons are one set
drawn in `@porkbot/ui` on a 24-unit grid with `currentColor`, so a glyph
cannot carry a colour of its own and no screen pastes a platform emoji. The
rule that a screen composes the register is checked rather than remembered:
`packages/eslint-config/ui-register.js` names the markup each primitive owns and
the lint rule fails a surface that writes it, with a fixture per entry and a
test tying the register's component names to the package's exports. The
register's specimen captures — the components and the overlays, each mode — live
under `docs/screenshots/register-light.png`, `register-dark.png` and the
overlays pair beside them, taken at 1280 from the register's own stylesheet;
the screens' chrome is now the register's markup rather than a copy of it.

| Primitive                                                 | States to cover                                  | Used by                                               |
| --------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Button: primary, neutral, ghost, destructive; icon button | default, hover, focus-visible, disabled, loading | Approval pills, composer, every action                |
| Field, input, textarea, select                            | default, focus-visible, invalid, disabled        | Bot editor, settings, filters, routines               |
| Badge and state chip                                      | the six states above; count badge                | Rail, thread header, inspector                        |
| Bot avatar (mascot, override colour, uploaded image)      | sizes 20/24/32/40; fallback shape                | Rail, headers, attribution, computer chrome           |
| Card                                                      | flat, raised, interactive                        | Report cards, attachments, inspector sections         |
| Separator                                                 | horizontal, vertical                             | Inspector, menus, settings                            |
| Scroll area                                               | overflow, focus within                           | Rail, transcript, inspector                           |
| Tabs                                                      | active, hover, focus-visible                     | Computer surface (screen, terminal, files), settings  |
| Icon                                                      | the one set; no colour or emoji                  | Icon buttons, state chips, menu and toast chrome      |
| Menu                                                      | open, keyboard, destructive item                 | Lifecycle state control, rail footer, message actions |
| Dialog and sheet                                          | open, close, escape, focus return                | Confirmation, provider picker, switcher               |
| Tooltip                                                   | hover, focus                                     | Icon-only controls                                    |
| Toast                                                     | enter, dismiss, action link                      | Finished, failed and stuck runs                       |
| Skeleton                                                  | static under reduced motion                      | Every data screen's loading state                     |

| Composite                    | Built from                                           | Where                                           |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Rail row                     | avatar, name, latest activity, state chip            | The roster                                      |
| Bubble                       | card, attribution, timestamp separator               | The transcript                                  |
| Attachment and artifact card | card, file metadata, one action                      | Inside a bubble                                 |
| Report card                  | card, ✓ and → lines, tool entries                    | Closes a run                                    |
| Tool timeline entry          | disclosure, tool name, target, duration, result      | The transcript and the run surface              |
| Approval card                | card, consequence, deadline, two pills               | The transcript and the inspector                |
| Composer                     | textarea, attachment field, send, stop               | The content pane's bottom                       |
| Inspector section            | heading, rows, empty state                           | State, live screen, routines, pending approvals |
| Window chrome                | traffic lights, address or title, tabs, take control | The computer surface                            |

## Screenshot set

These captures define done. A slice that changes a screen regenerates its row
in place and attaches the new capture to its pull request; the acceptance
slice re-captures the whole set and lays it beside the mocks and the reference
screenshots for the operator's verdict.

| Capture                             | Shows                                                        | Width | Mode  |
| ----------------------------------- | ------------------------------------------------------------ | ----- | ----- |
| `interface-thread-1280-dark.png`    | Roster, thread, inspector, all six states in the rail        | 1280  | dark  |
| `interface-thread-1280-light.png`   | The same screen in the light mode                            | 1280  | light |
| `interface-thread-390-dark.png`     | The thread and the switcher sheet, one pane, no scroll       | 390   | dark  |
| `interface-thread-390-light.png`    | The same screen in the light mode                            | 390   | light |
| `interface-computer-1280-dark.png`  | The computer surface, its tabs, its state control, inspector | 1280  | dark  |
| `interface-computer-1280-light.png` | The same screen in the light mode                            | 1280  | light |
| `interface-shell-768-dark.png`      | The middle breakpoint: the pane switcher, no rail            | 768   | dark  |
| `interface-approval-390-dark.png`   | An inline approval card at the narrow width                  | 390   | dark  |
| `interface-states-dark.png`         | The six state chips in rail context                          | 1280  | dark  |
| `interface-states-light.png`        | The six state chips in rail context                          | 1280  | light |

The first six rows are the mocks' captures from slice 13.1; the rest are
targets for the slices that build them.

## Sign-off

The direction is ratified by the operator, and a correction lands in this file
rather than in a comment. The mocks' screenshots are the evidence the verdict
was taken on.

| Date       | Verdict    | Corrections |
| ---------- | ---------- | ----------- |
| 2026-09-21 | Signed off | —           |
