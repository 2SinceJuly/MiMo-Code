import type { Config } from "@/config"
import { Flag } from "@/flag/flag"
import type { Provider } from "@/provider"
import { ProviderTransform } from "@/provider"
import { Log, Token, Wildcard } from "@/util"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 33_000

// Cap the output reservation so models with large output windows (e.g. 32K, 64K)
// don't strangle the usable input window. 20K covers >99.99% of compaction
// summary outputs based on production telemetry of summary token counts.
const OUTPUT_CAP = 20_000

// Compaction fires when usage reaches a fraction of the working window, leaving
// the remaining headroom for the summary generation. The default 0.9 keeps the
// trigger at a flat 90% of the model's context regardless of window size,
// instead of a fixed token reserve that punishes small windows. Override with
// MIMOCODE_COMPACTION_TRIGGER_RATIO.

const log = Log.create({ service: "session.overflow" })
const warned = new Set<string>()

export type Window = {
  /** Largest prompt the provider accepts. 0 means unknown — overflow handling is off. */
  hard: number
  /** Working window after the `compaction.max_context` budget and the request's session cap are applied. */
  effective: number
  /** Token count at which compaction fires (a fixed fraction of `effective`). */
  usable: number
  source: "model" | "config" | "session"
}

type WindowInput = {
  cfg: Config.Info
  model: Provider.Model
  /** Per-request cap from the turn's user message; it only lowers the window. */
  cap?: number
}

/** The context window cap a turn's user message requests, if any. */
export function sessionCap(user: MessageV2.User | undefined) {
  return user?.model.contextLimit
}

/**
 * A synthetic user message the loop will treat as `lastUser` must keep the cap of
 * the user turn it continues; otherwise that turn silently runs on the full window.
 */
export function withSessionCap(model: MessageV2.User["model"], user: MessageV2.User | undefined): MessageV2.User["model"] {
  const cap = sessionCap(user)
  return cap ? { ...model, contextLimit: cap } : model
}

/**
 * The model's raw `limit.context` lowered to the session cap when `contextWindow`
 * applies it, so raw-context consumers agree with the overflow window.
 */
export function cappedContext(input: { cfg: Config.Info; model: Provider.Model; cap?: number }) {
  const win = contextWindow(input)
  return win.source === "session" ? win.effective : input.model.limit.context
}

function reserves(input: { cfg: Config.Info; model: Provider.Model }) {
  const reserved =
    input.cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model))
  // When the provider publishes a dedicated input cap, output tokens are already
  // outside it, so reserving output headroom again would double-count.
  const output = input.model.limit.input ? 0 : Math.min(ProviderTransform.maxOutputTokens(input.model), OUTPUT_CAP)
  return reserved + output
}

function budget(input: { cfg: Config.Info; model: Provider.Model }, hard: number, reserved: number) {
  const configured = input.cfg.compaction?.max_context ?? Flag.MIMOCODE_COMPACTION_MAX_CONTEXT
  if (configured === undefined) return undefined
  const key = `${input.model.providerID}/${input.model.id}`
  const raw =
    typeof configured === "object"
      ? (Wildcard.all(key, configured as Record<string, number | string>) as number | string | undefined)
      : configured
  if (raw === undefined) return undefined
  if (raw === "") return undefined

  const parsed = Token.parseQuantity(raw, hard)
  // 0 means "no budget for this model" — a config merge cannot delete a key, so this is
  // how the UI restores a model to its own window. Not a misconfiguration, so no warning.
  if (parsed === 0) return undefined
  if (parsed === undefined || parsed <= reserved) {
    if (!warned.has(`${key}:${raw}`)) {
      warned.add(`${key}:${raw}`)
      log.warn("ignoring compaction.max_context", {
        model: key,
        value: raw,
        reason: parsed === undefined ? "unparseable" : `must exceed ${reserved} reserved tokens`,
      })
    }
    return undefined
  }
  // A budget at or above the provider cap is a no-op — report it as such so the
  // UI keeps attributing the window to the model.
  if (parsed >= hard) return undefined
  return parsed
}

/**
 * Resolve the provider cap, the user's working budget, and the compaction
 * trigger for a model. `usable()` is the trigger; the other fields exist so the
 * TUI and CLI can explain where the number came from.
 */
export function contextWindow(input: WindowInput): Window {
  const hard = input.model.limit.context === 0 ? 0 : input.model.limit.input || input.model.limit.context
  if (hard === 0) return { hard: 0, effective: 0, usable: 0, source: "model" }

  const reserved = reserves(input)
  const configured = budget(input, hard, reserved)
  const base = configured ?? hard
  // Same guards as the config budget: a cap that leaves no room for the
  // reserves is ignored, and one at or above the provider cap is a no-op.
  const cap = input.cap && input.cap > reserved && input.cap < hard ? input.cap : undefined
  const effective = cap && cap < base ? cap : base
  return {
    hard,
    effective,
    usable: Math.floor(effective * Flag.MIMOCODE_COMPACTION_TRIGGER_RATIO),
    source: effective !== base ? "session" : configured === undefined ? "model" : "config",
  }
}

export function usable(input: WindowInput) {
  return contextWindow(input).usable
}

export function isOverflow(input: WindowInput & { tokens: MessageV2.Assistant["tokens"] }) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
