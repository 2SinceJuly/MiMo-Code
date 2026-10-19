/**
 * Completion-footer visibility for an assistant message row.
 *
 * The footer (`▣ Mode · model · duration`) is the last row of the scrollable
 * transcript. It must stay mounted for the live last message — including
 * mid-loop `finish === "tool-calls"` steps — so sticky bottom never has a hole
 * where the row used to be. The only tool-calls row we still suppress is a
 * trailing Orchestrator message that follows an already-settled turn, so the
 * stop/aborted message keeps the single duration footer.
 */

export type AssistantFooterMessage = {
  id: string
  role: string
  parentID?: string
  finish?: string | null
  error?: { name?: string } | null
}

function isSettledFooterRow(message: AssistantFooterMessage): boolean {
  const isFinal = Boolean(message.finish) && message.finish !== "tool-calls"
  return isFinal || message.error?.name === "MessageAbortedError"
}

/**
 * True when an earlier assistant row in the same turn already draws the
 * settled turn footer. Scope by `parentID` (the user message that opened the
 * turn) — a global scan would treat every later mid-loop `tool-calls` step as
 * trailing after turn 1 and re-hide the live last row on turn 2+.
 */
export function hasPriorFinalAssistant(
  messages: ReadonlyArray<AssistantFooterMessage>,
  current: { id: string; parentID?: string },
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.id < current.id &&
      message.parentID === current.parentID &&
      isSettledFooterRow(message),
  )
}

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
