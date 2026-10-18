// WAORGNUMBER.3 (R6) — the acknowledgement a customer gets for STOP / START in
// a WhatsApp thread at a studio.
//
// Since R6 a keyword acts at the studio whose thread it arrives in, so the ack
// names that studio: a member of both studios who STOPs Hatch Street still gets
// Stillorgan's messages, and "You've been unsubscribed from WhatsApp marketing"
// would promise more than happened.
//
// Operator-editable per studio (customer-comms-editable rule):
//   locations.settings.whatsapp_consent_copy.{stop_ack, start_ack}
// saved through PUT /api/locations/[id]/whatsapp/consent-copy. A blank or
// missing field uses the default below. `{studio}` in either is replaced with
// locations.name.
//
// Pure on purpose (no server imports): the settings card reads the defaults
// and the placeholder from here too.

export const CONSENT_COPY_KEYS = ['stop_ack', 'start_ack']

// WhatsApp allows 4096 characters in a text message; this is a short reply.
export const CONSENT_COPY_MAX = 500

export const STUDIO_PLACEHOLDER = '{studio}'

// No em-dashes in customer copy (Richard's rule).
export const DEFAULT_CONSENT_COPY = {
  stop_ack: "You won't get WhatsApp marketing from {studio} any more. Reply START to opt back in.",
  start_ack: "You're back on WhatsApp messages from {studio}. Reply STOP to opt out.",
}

// Used for {studio} when the studio's name could not be read: the thread IS
// with that studio, so "us" is still true.
const UNNAMED_STUDIO = 'us'

/** The studio's saved copy, `{ stop_ack, start_ack }`, each a string or null (= default). */
export function savedConsentCopy(settings) {
  const saved = settings && typeof settings === 'object' ? settings.whatsapp_consent_copy : null
  const out = {}
  for (const key of CONSENT_COPY_KEYS) {
    const v = saved && typeof saved === 'object' ? saved[key] : null
    out[key] = typeof v === 'string' && v.trim() ? v : null
  }
  return out
}

/**
 * The acknowledgement text for a keyword at a studio.
 *
 * @param {{ name?: string|null, settings?: object|null }|null} location
 * @param {boolean} optingOut  true for STOP, false for START
 * @returns {string}
 */
export function consentAckText(location, optingOut) {
  const key = optingOut ? 'stop_ack' : 'start_ack'
  const template = savedConsentCopy(location?.settings)[key] || DEFAULT_CONSENT_COPY[key]
  const name = typeof location?.name === 'string' && location.name.trim() ? location.name.trim() : UNNAMED_STUDIO
  return template.split(STUDIO_PLACEHOLDER).join(name)
}
