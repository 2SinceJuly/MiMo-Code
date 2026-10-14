import z from "zod"
import type { MessageID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"

export type Lane = { sessionID: SessionID; agentID: string }

/**
 * Single intent shape. `messageID` is the user message written at accept.
 * resume/shell are exclusive entry points and never write inbox rows.
 */
export type Intent = {
  messageID: MessageID
  type: string
  senderSessionID?: SessionID
  senderActorID?: string
}

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
  outcome?: ReceiptOutcome
  messageId?: MessageID
  deliveryMessageId?: MessageID
  error?: string
  idempotencyKey?: string
  time: { created: number; updated: number }
}

export type AcceptInput = {
  lane: Lane
  message: MessageV2.User
  parts: MessageV2.Part[]
  intent: Intent
  idempotencyKey?: string
}

export const ReceiptStateSchema = z.enum(["accepted", "claimed", "settled", "cancelled", "rejected"])
export const ReceiptOutcomeSchema = z.enum(["success", "assistant_error", "interrupted", "never_ran"])

export const PublicIntentSchema = z.object({
  messageID: z.string(),
  type: z.string(),
  senderSessionID: z.string().optional(),
  senderActorID: z.string().optional(),
})
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
  outcome: ReceiptOutcomeSchema.optional(),
  messageId: z.string().optional(),
  deliveryMessageId: z.string().optional(),
  error: z.string().optional(),
})
export type PublicReceipt = z.infer<typeof PublicReceipt>

function publicIntent(intent: Intent): PublicIntent {
  return {
    messageID: String(intent.messageID),
    type: intent.type,
    ...(intent.senderSessionID ? { senderSessionID: String(intent.senderSessionID) } : {}),
    ...(intent.senderActorID ? { senderActorID: intent.senderActorID } : {}),
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
    ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
    ...(receipt.messageId ? { messageId: String(receipt.messageId) } : {}),
    ...(receipt.deliveryMessageId ? { deliveryMessageId: String(receipt.deliveryMessageId) } : {}),
    ...(receipt.error ? { error: receipt.error } : {}),
  }
}

export const DEFAULT_AGENT = "main"

/** Single claim batch cap per step boundary. */
export const MAX_CLAIM_PER_STEP = 100
