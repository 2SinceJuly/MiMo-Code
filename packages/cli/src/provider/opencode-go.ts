import type { Model } from "./provider"

/**
 * OpenCode Go (`https://opencode.ai/zen/go`) hard-rejects inference requests with
 * no stable per-conversation `x-opencode-session` (400 MissingSessionID) since
 * 2026-09-05. Only that gateway requires the header.
 *
 * Detection must see BOTH the model and the provider-level options: a custom
 * provider often points at Go only via `provider.options.baseURL` (the TUI
 * dialog writes exactly that), and that value never lands on `Provider.Model`.
 */
export function isOpenCodeGoTarget(
  model: Pick<Model, "providerID" | "api" | "options">,
  providerOptions?: Record<string, unknown> | undefined,
): boolean {
  const providerID = String(model.providerID ?? "")
  if (providerID.startsWith("opencode-go")) return true
  const options = model.options as { baseURL?: unknown; baseUrl?: unknown } | undefined
  const candidates = [
    model.api?.url,
    options?.baseURL,
    options?.baseUrl,
    providerOptions?.baseURL,
    providerOptions?.baseUrl,
  ]
  return candidates.some((url) => typeof url === "string" && url.includes("opencode.ai/zen/go"))
}

/**
 * Headers for OpenCode Go only. Non-Go targets get `{}` so their outbound
 * requests stay byte-identical. Empty/missing `sessionID` adds nothing (the
 * gateway would 400 either way; inventing an ID here would mis-route cache).
 */
export function openCodeGoSessionHeaders(
  model: Pick<Model, "providerID" | "api" | "options">,
  sessionID: string | undefined,
  providerOptions?: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!sessionID) return {}
  if (!isOpenCodeGoTarget(model, providerOptions)) return {}
  return { "x-opencode-session": sessionID }
}
