export function isActorToolRunning(input: {
  partStatus: string
  action?: string
  actorStatus?: string
}) {
  if (input.partStatus === "running") return true
  if (input.partStatus !== "completed") return false
  if (input.action !== "spawn") return false
  return input.actorStatus === "running" || input.actorStatus === "pending"
}

/**
 * InlineTool's generic `~ {pending}` fallback. `send` / `wait` / `status` /
 * `cancel` / `models` are not delegations — label them by action so a finished
 * call never sits on "Delegating...".
 */
export function actorToolPendingLabel(action?: string): string {
  switch (action) {
    case "send":
      return "Sending..."
    case "wait":
      return "Waiting..."
    case "status":
      return "Checking status..."
    case "cancel":
      return "Cancelling..."
    case "models":
      return "Listing models..."
    default:
      return "Delegating..."
  }
}

/**
 * Truthy once InlineTool should leave the pending fallback. `spawn`/`run`
 * identify themselves by `description`; the other actions have no description
 * field and must key off their target (or a resolved tool title) instead —
 * otherwise a completed `actor send` sticks on the pending label forever.
 */
export function actorToolCompleteKey(input: {
  action?: string
  description?: string
  actorDescription?: string
  toActorId?: string
  actorId?: string
  title?: string
}): string | true | undefined {
  if (input.description) return input.description
  if (input.actorDescription) return input.actorDescription
  switch (input.action) {
    case "send":
      return input.toActorId ?? input.title ?? true
    case "wait":
    case "status":
    case "cancel":
      return input.actorId ?? input.title ?? true
    case "models":
      return input.title ?? true
    case "spawn":
    case "run":
      return input.title
    default:
      return input.title
  }
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * One-line body for the actor tool once it leaves the pending fallback.
 * Multi-line live-progress (toolcounts) is layered on by the TUI caller.
 */
export function actorToolBody(input: {
  action?: string
  partStatus: string
  description?: string
  actorDescription?: string
  subagentType?: string
  agent?: string
  toActorId?: string
  actorId?: string
  content?: string
}): string {
  const desc = input.description ?? input.actorDescription
  const agent = input.subagentType ?? input.agent ?? "General"

  if (input.action === "send") {
    const to = input.toActorId ?? input.actorId ?? "peer"
    const label = input.partStatus === "running" ? `Sending to ${to}` : `Sent to ${to}`
    const preview = input.content ? clip(input.content, 60) : ""
    return preview ? `${label} — ${preview}` : label
  }

  if (input.action === "cancel") {
    const label = input.partStatus === "running" ? "Cancelling" : "Cancelled"
    return desc ? `${label} — ${desc}` : `${label} — ${input.actorId ?? ""}`.trimEnd()
  }

  if (input.action === "wait") {
    const label = input.partStatus === "completed" ? "Waited for" : "Waiting for"
    return desc ? `${label} — ${desc}` : `${label} — ${input.actorId ?? ""}`.trimEnd()
  }

  if (input.action === "status") {
    return desc ? `Status — ${desc}` : `Status — ${input.actorId ?? ""}`.trimEnd()
  }

  if (input.action === "models") {
    return "List models"
  }

  if (input.action === "spawn") {
    return desc ? `Background ${agent} Task — ${desc}` : `Background ${agent} Task`
  }

  // run (and any future action with a description)
  return desc ? `${agent} Task — ${desc}` : `${agent} Task`
}
