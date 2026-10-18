// UN1TWRITE.21 — the seam spec E (Mia at Hatch) fills. D ships the defaults:
// nothing is handed to Mia, and the trial-used email lists no products (its
// {options} then reads DEFAULT_TRIAL_USED_OPTIONS). E's plan replaces both
// bodies; the funnel processor only calls them.

/**
 * Hand a trial-used person to Mia's upsell in their WhatsApp thread instead
 * of the email (E 6.5). D's default hands off nothing.
 * @returns {Promise<{ handled: boolean }>}
 */
// eslint-disable-next-line no-unused-vars
export async function trialUsedHandoff(db, { request, contact, locationId } = {}) {
  return { handled: false }
}

/**
 * The studio's offer list for the trial-used email, one product per line
 * (title and price, never capacity). D's default: none.
 * @returns {Promise<string|null>}
 */
// eslint-disable-next-line no-unused-vars
export async function trialUsedOptionsText(db, locationId) {
  return null
}
