/**
 * Completion-footer visibility for an assistant message row.
 *
 * The footer (`▣ Mode · model · duration`) is the last row of the scrollable
 * transcript and must stay mounted — including mid-loop `finish === "tool-calls"`
 * steps. The old gate hid the row whenever the last message finished with
 * tool-calls, so the last line vanished for the whole tool window and flickered
 * at the process→complete transition. Orchestrator (the only reason that gate
 * existed) is gone, so a trailing tool-calls row no longer needs suppressing.
 */
export function shouldShowAssistantFooter(input: {
  recovering: boolean
  aborted: boolean
  finish: string | undefined
  isLast: boolean
}): boolean {
  if (input.recovering) return true
  if (input.aborted) return true
  const isFinal = Boolean(input.finish) && input.finish !== "tool-calls"
  if (isFinal) return true
  return input.isLast
}
