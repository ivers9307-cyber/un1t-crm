// WACONFIGFALLBACK.1 — the refusal for "this location has no WhatsApp number
// of its own".
//
// getWhatsAppConfig used to fall back to the global WHATSAPP_* env number
// when a location had no active whatsapp_numbers row, so a send, a template
// write or a block at such a location acted on another studio's number (and
// replies to it routed to that studio's inbox and Mia). The env tier is gone;
// every resolver now throws THIS error instead, and each caller decides what
// a refusal means for it (a 409 to staff, a recorded skip in a sequence, a
// paused drip, a quiet sent:false in a best-effort confirmation). The table
// of callers and their decisions is tests/whatsapp-config-callers.test.js.
//
// Pure: no imports, so a test or a mocked module graph can build one and
// recognise one without pulling Supabase in.

export const WA_NO_NUMBER = 'WA_NO_NUMBER'
export const NO_WHATSAPP_NUMBER_MESSAGE = 'No WhatsApp number is connected at this location.'
export const NO_LOCATION_MESSAGE = 'No location was given to send this WhatsApp from.'

export class WhatsAppNumberMissingError extends Error {
  /** @param {string | null | undefined} locationId */
  constructor(locationId) {
    super(locationId ? NO_WHATSAPP_NUMBER_MESSAGE : NO_LOCATION_MESSAGE)
    this.name = 'WhatsAppNumberMissingError'
    this.code = WA_NO_NUMBER
    this.locationId = locationId || null
  }
}

/** True for the typed refusal, judged by its code so it survives a mock. */
export function isWhatsAppNumberMissing(err) {
  return err?.code === WA_NO_NUMBER
}

/**
 * The HTTP status a staff route answers a failed WhatsApp call with: 409 for
 * a location with no number (a setup state, not a Meta failure), otherwise
 * the route's own status (its 400/502 is unchanged).
 */
export function whatsappErrorStatus(err, fallbackStatus) {
  return isWhatsAppNumberMissing(err) ? 409 : fallbackStatus
}
