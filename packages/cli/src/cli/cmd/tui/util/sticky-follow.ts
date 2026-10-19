/**
 * Follow-bottom helpers for the session transcript ScrollBox.
 *
 * opentui's `stickyScroll` + `stickyStart="bottom"` tracks the edge, but a
 * height change (tool process→complete, footer mount) can land in a frame
 * where `scrollHeight` has grown and the bar has not been re-applied yet —
 * the last row is then just out of view. Re-snap after layout when the user
 * is still in follow mode. `_hasManualScroll` is the same authority the
 * agent-switch path uses: set only on a user scroll away from the sticky
 * edge, cleared when they return.
 */

export type StickyScrollBox = {
  _hasManualScroll?: boolean
  isDestroyed?: boolean
  scrollHeight: number
  scrollTo: (y: number) => void
}

export function isFollowingBottom(scroll: { _hasManualScroll?: boolean } | undefined): boolean {
  if (!scroll) return false
  // Missing flag → treat as following (safe direction: snap rather than leave
  // a stale offset). Matches the agent-switch fallback.
  return scroll._hasManualScroll !== true
}

export function followStickyBottom(scroll: StickyScrollBox | undefined): void {
  if (!scroll || scroll.isDestroyed) return
  if (!isFollowingBottom(scroll)) return
  scroll.scrollTo(scroll.scrollHeight)
}

/**
 * Coalesce part/message height changes into one post-layout snap. The
 * synchronous event fires before Solid re-renders and opentui lays out the
 * taller content, so an immediate `scrollTo(scrollHeight)` still sees the old
 * height and the next frame is short exactly one row.
 */
export function scheduleFollowStickyBottom(
  scroll: StickyScrollBox | undefined,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout },
  delayMs = 0,
): void {
  const state = scheduleFollowStickyBottom.state
  if (state.timer !== undefined) timers.clearTimeout(state.timer)
  state.timer = timers.setTimeout(() => {
    state.timer = undefined
    followStickyBottom(scroll)
  }, delayMs)
}

scheduleFollowStickyBottom.state = { timer: undefined as ReturnType<typeof setTimeout> | undefined }
