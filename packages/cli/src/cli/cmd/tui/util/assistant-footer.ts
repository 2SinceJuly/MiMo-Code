/**
 * Completion-footer visibility for an assistant message row.
 *
 * The footer (`▣ Mode · model · duration`) is the last row of the scrollable
 * transcript. It must stay mounted for the live last message — including
 * mid-loop `finish === "tool-calls"` steps — so sticky bottom never has a hole
 * where the row used to be. The only tool-calls row we still suppress is a
 * trailing Orchestrator message that follows an already-final turn, so the
 * stop message keeps the single duration footer.
 */
export function shouldShowAssistantFooter(input: {
  recovering: boolean
  aborted: boolean
  finish: string | undefined
  isLast: boolean
  hasPriorFinal: boolean
}): boolean {
  if (input.recovering) return true
  if (input.aborted) return true
  const isFinal = Boolean(input.finish) && input.finish !== "tool-calls"
  if (isFinal) return true
  if (!input.isLast) return false
  if (input.finish === "tool-calls") return !input.hasPriorFinal
  return true
}
