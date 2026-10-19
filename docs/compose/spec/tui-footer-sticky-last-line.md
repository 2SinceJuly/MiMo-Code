---
feature: tui-footer-sticky-last-line
status: delivered
updated: 2026-07-11
branch: fix/tui-footer-sticky-last-line
commits: 67fecf88..55e10011
---

# TUI footer last-line flicker

## Report

**What was built** — The session transcript's completion footer (`▣ Mode · model · duration`) is now a stable last row while scroll tracks the bottom. Mid-loop `finish="tool-calls"` steps keep the live last row mounted (`shouldShowAssistantFooter` in `util/assistant-footer.ts`); only a trailing Orchestrator tool-calls row that follows an already-settled *same-turn* footer is suppressed, so the stop/aborted message still owns the single duration line. Tool process→complete height changes schedule a coalesced post-layout re-snap (`scheduleFollowStickyBottom` in `util/sticky-follow.ts`) that respects `_hasManualScroll` and never yanks a user who scrolled away.

**Verification** — `bun run typecheck` (packages/cli): PASS. `bun test ./test/cli/tui/ ./test/cli/cmd/tui/` (packages/cli): PASS, 374 tests / 0 fail (includes 12 footer-predicate + 7 sticky-follow cases). Independent review of `67fecf88..df0fc443` passed T2/T3 and flagged one critical: the prior-final scan was global by `id`, which re-hid the footer on turn 2+. Fixed in `55e10011` by scoping `hasPriorFinalAssistant` on `parentID` and treating a prior aborted row as owning the turn footer; multi-turn and aborted-prior cases covered in tests.

**Journey log** —
1. Symptom matched two mechanisms (footer unmount vs sticky off-by-one); both are real and both were fixed — do not drop either half.
2. `showFooter`'s old `finish !== "tool-calls"` guard was the unmount; keeping the live last row mounted is the whole point of the predicate.
3. Review caught that "prior final" must be turn-scoped (`parentID`), not a global `id` scan — a global scan collapses every later turn into "trailing after turn 1".
4. opentui `scrollTo(scrollHeight)` clamps via `scrollPosition` and clears `_hasManualScroll` at the bottom, so programmatic re-snap is safe w.r.t. manual-scroll authority.
5. Sticky re-snap must run *after* layout (`scheduleFollowStickyBottom`); an immediate snap still sees the old height.

## [S1] Problem

In the session TUI, the completion footer (`▣ Mode · model`, the orange agent glyph + mode + model) is the last line of the scrollable transcript. Scroll tracks the bottom (`stickyScroll` + `stickyStart="bottom"`), so that line should stay visible as a stable last row while content grows.

During a step's toolcall transition from process rendering to completed state, that line disappears for about one frame (screenshot gap above the prompt). Other transcript content still refreshes smoothly and the prompt bar under the scroll area never moves. Two mechanisms can produce the same symptom and both are in play:

1. **Footer unmount** — `showFooter` is `props.last && finish !== "tool-calls"` once `final()` is false. Mid-loop assistant messages write `finish = "tool-calls"` at `finish-step` (and actor tools write it even before the tool part flips to `completed`). On that write the last message stops drawing the footer until the next assistant message mounts, so the last row vanishes.
2. **Sticky off-by-one** — tool complete often changes content height (InlineTool ↔ BlockTool, `renderBefore` margin 0→1, hidden tool rows). `recalculateBarProps` → `applyStickyStart` can lag that growth by a frame, so the viewport is one row short and clips exactly the footer.

## [S2] Design

**Footer stability.** The last assistant row is the live turn status line. Keep it mounted for every last message, including `finish === "tool-calls"` mid-loop steps. Only suppress the trailing Orchestrator `tool-calls` message that follows an already-settled footer in the **same turn** (`parentID`), so the stop/aborted message still owns the single duration footer.

Pure predicates (testable without the view):

```ts
hasPriorFinalAssistant(messages, current) // same parentID + earlier id + settled row
shouldShowAssistantFooter({
  recovering,
  aborted,
  finish,      // message.finish
  isLast,
  hasPriorFinal,
})
```

| recovering / aborted | `final()` | `isLast` | `finish === "tool-calls"` | `hasPriorFinal` | show |
| --- | --- | --- | --- | --- | --- |
| true | * | * | * | * | yes |
| false | true | * | * | * | yes |
| false | false | false | * | * | no |
| false | false | true | false | * | yes |
| false | false | true | true | false | yes (mid-loop live row) |
| false | false | true | true | true | no (trailing after a settled same-turn footer) |

`hasPriorFinal` is true only for an earlier assistant message with the same `parentID` that is settled (`finish` set and ≠ `"tool-calls"`, or `MessageAbortedError`). A prior turn's settled row must not count. Duration still only renders when `final()` is true.

**Sticky follow.** When the user is in follow-bottom mode (`!_hasManualScroll`) and transcript height changes (tool complete, part row, footer mount), re-apply bottom after layout so the last row is never clipped. Use the same `_hasManualScroll` authority the agent-switch path already documents; never yank a user who scrolled away. Height-change snaps are coalesced so a burst of part updates yields one post-layout snap.

**Out of scope.** Prompt-embedded mode/model row, sidebar status, pinning a footer overlay outside the scroll content, Orchestrator UX changes beyond the existing single-footer rule.

## [S3] Out of Scope

- Changing footer copy, glyphs, or duration math
- Sticky behavior when the user has manually scrolled
- Non-session scrollboxes (workflow page, dialogs)

## Tasks

- [x] T1: Extract `shouldShowAssistantFooter` and wire `AssistantMessage.showFooter` — acceptance: mid-loop last message with `finish=tool-calls` and no prior final shows the footer; trailing tool-calls after a settled same-turn footer does not (covers: S2)
- [x] T2: Re-apply sticky bottom after transcript height changes in follow mode — acceptance: tool process→complete growth keeps the footer row in the viewport; manual scroll is left alone (covers: S2)
- [x] T3: Regression tests for the footer predicate and follow-bottom reapply — acceptance: `bun test` packages/cli footer/sticky cases pass (covers: S2; depends: T1, T2)
