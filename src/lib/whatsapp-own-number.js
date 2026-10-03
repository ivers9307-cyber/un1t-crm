// WACONFIGFALLBACK.1 — "this location's own WhatsApp number, or why not", for
// the session routes that act AT META on the location's account (template
// create / sync / delete / resubmit, header-media upload, chat openers).
//
// A route calls this before any Meta call and answers the refusal as-is:
//   409 — the location has no active whatsapp_numbers row (a setup state)
//   500 — the lookup itself failed (logged; never read as "no number", and
//         never as "use some other number")
// The returned config is passed to the whatsapp.js helper as `{ config }`,
// so the helper never re-resolves.

import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { logError } from '@/lib/log'
import { NO_WHATSAPP_NUMBER_MESSAGE, NO_LOCATION_MESSAGE } from '@/lib/whatsapp-number-missing'

export const NUMBER_LOOKUP_FAILED_MESSAGE = "Could not check this location's WhatsApp number just now."

/**
 * @param {string | null | undefined} locationId
 * @param {string} scope  logError scope of the calling route
 * @returns {Promise<{ ok: true, config: object } | { ok: false, status: 409 | 500, error: string }>}
 */
export async function ownNumberOrRefusal(locationId, scope) {
  if (!locationId) return { ok: false, status: 409, error: NO_LOCATION_MESSAGE }
  let config
  try {
    config = await getLocationWhatsAppNumberConfig(locationId)
  } catch (e) {
    logError(scope, 'number lookup failed', { locationId, err: e?.message })
    return { ok: false, status: 500, error: NUMBER_LOOKUP_FAILED_MESSAGE }
  }
  if (!config) return { ok: false, status: 409, error: NO_WHATSAPP_NUMBER_MESSAGE }
  return { ok: true, config }
}
