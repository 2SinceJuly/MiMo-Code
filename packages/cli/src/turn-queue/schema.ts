import z from "zod"
import type { MessageID, SessionID } from "@/session/schema"

export type Lane = { sessionID: SessionID; agentID: string }

export type PromptIntent = { kind: "prompt"; messageID: MessageID }
export type ResumeIntent = {
  kind: "resume"
  assistantID: MessageID
  plan: "user-resume" | "tool-resume"
  expectedAssistantStatus?: string
}
export type WakeIntent = {
  kind: "wake"
  receiverActorID: string
  inboxWatermark: string
}
export type ShellIntent = { kind: "shell"; command: string; cwd?: string }

export type Intent = PromptIntent | ResumeIntent | WakeIntent | ShellIntent

export type ReceiptState = "accepted" | "claimed" | "settled" | "cancelled" | "rejected"
export type ReceiptOutcome = "success" | "assistant_error" | "interrupted" | "never_ran"

export type Receipt = {
  id: string
  lane: Lane
  state: ReceiptState
  intent: Intent
  epoch: number
  runId?: number
  claimFrontier?: MessageID
  consumed: boolean
  suspended: boolean
  outcome?: ReceiptOutcome
  messageId?: MessageID
  deliveryMessageId?: MessageID
  error?: string
  idempotencyKey?: string
  time: { created: number; updated: number }
}

export type AdmitInput = {
  lane: Lane
  intent: Intent
  idempotencyKey?: string
}

export type AbortPolicy = "drop" | "keep-suspended"

export const ReceiptStateSchema = z.enum(["accepted", "claimed", "settled", "cancelled", "rejected"])
export const ReceiptOutcomeSchema = z.enum(["success", "assistant_error", "interrupted", "never_ran"])

/**
 * Public intent projection. Claim-concurrency fields (expectedAssistantStatus)
 * stay internal and are stripped here.
 */
export const PublicIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), messageID: z.string() }),
  z.object({
    kind: z.literal("resume"),
    assistantID: z.string(),
    plan: z.enum(["user-resume", "tool-resume"]),
  }),
  z.object({ kind: z.literal("wake"), receiverActorID: z.string(), inboxWatermark: z.string() }),
  z.object({ kind: z.literal("shell"), command: z.string(), cwd: z.string().optional() }),
])
export type PublicIntent = z.infer<typeof PublicIntentSchema>

/**
 * Single source for the GET receipt response body and its OpenAPI schema.
 * Internal claim bookkeeping (runId, claimFrontier, idempotencyKey, time) is
 * not part of the external contract.
 */
export const PublicReceipt = z.object({
  id: z.string(),
  lane: z.object({ sessionID: z.string(), agentID: z.string() }),
  state: ReceiptStateSchema,
  intent: PublicIntentSchema,
  epoch: z.number(),
  consumed: z.boolean(),
  suspended: z.boolean(),
  outcome: ReceiptOutcomeSchema.optional(),
  messageId: z.string().optional(),
  deliveryMessageId: z.string().optional(),
  error: z.string().optional(),
})
export type PublicReceipt = z.infer<typeof PublicReceipt>

function publicIntent(intent: Intent): PublicIntent {
  switch (intent.kind) {
    case "prompt":
      return { kind: "prompt", messageID: intent.messageID }
    case "resume":
      return { kind: "resume", assistantID: intent.assistantID, plan: intent.plan }
    case "wake":
      return { kind: "wake", receiverActorID: intent.receiverActorID, inboxWatermark: intent.inboxWatermark }
    case "shell":
      return { kind: "shell", command: intent.command, ...(intent.cwd ? { cwd: intent.cwd } : {}) }
  }
}

/** Map an internal Receipt onto the external contract (OpenAPI = this shape). */
export function toPublicReceipt(receipt: Receipt): PublicReceipt {
  return {
    id: receipt.id,
    lane: { sessionID: String(receipt.lane.sessionID), agentID: receipt.lane.agentID },
    state: receipt.state,
    intent: publicIntent(receipt.intent),
    epoch: receipt.epoch,
    consumed: receipt.consumed,
    suspended: receipt.suspended,
    ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
    ...(receipt.messageId ? { messageId: String(receipt.messageId) } : {}),
    ...(receipt.deliveryMessageId ? { deliveryMessageId: String(receipt.deliveryMessageId) } : {}),
    ...(receipt.error ? { error: receipt.error } : {}),
  }
}

/** Eligibility order for mailbox pop (lower = first). Not a transcript reorder. */
export function intentRank(intent: Intent): number {
  switch (intent.kind) {
    case "prompt":
      return 0
    case "resume":
      return intent.plan === "user-resume" ? 1 : 2
    case "wake":
      return 3
    case "shell":
      return 4
  }
}

export function isCoalescable(intent: Intent): intent is WakeIntent {
  return intent.kind === "wake"
}

/** inputRevision bumps only for user-facing steer (prompt). Wake/shell never steer. */
export function bumpsInputRevision(intent: Intent): boolean {
  return intent.kind === "prompt"
}

export const DEFAULT_AGENT = "main"
