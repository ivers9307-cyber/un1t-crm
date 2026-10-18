// WAORGNUMBER.1 — the /communications hub's WhatsApp health card (Meta quality
// rating + messaging tier, stored by the refresh-whatsapp-health cron, mig 329).
//
// Extracted from page.js (JSX in a .js file the node vitest cannot import) so
// the read is testable. It is the number SWITCHED ON at this studio (link
// default first, else the newest switch-on), whatever its home studio: an
// organisation number shows the same health at every studio it is on. Before
// WAORGNUMBER.1 it read whatsapp_numbers by `location_id`, the number's home.
//
// The card is decorative: a failed read hides it (logged), as before, and never
// throws into the page.
import { getLocationWhatsAppNumberConfig } from '@/lib/whatsapp-config'
import { logWarn } from '@/lib/log'

/**
 * @param {string} locationId
 * @returns {Promise<{ quality_rating: string|null, messaging_limit_tier: string|null, quality_checked_at: string|null } | null>}
 */
export async function loadWhatsAppHubHealth(locationId) {
  try {
    const num = await getLocationWhatsAppNumberConfig(locationId)
    if (!num) return null
    return {
      quality_rating: num.qualityRating ?? null,
      messaging_limit_tier: num.messagingLimitTier ?? null,
      quality_checked_at: num.qualityCheckedAt ?? null,
    }
  } catch (e) {
    logWarn('communications-hub', 'WhatsApp number health unreadable; the health card is hidden', { locationId, err: e?.message || String(e) })
    return null
  }
}
