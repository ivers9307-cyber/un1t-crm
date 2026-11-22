// EMAILBAR.1 — the logo a studio's marketing emails show on the black header
// bar (company_settings.email_logo_url, mig 870): light artwork on a dark
// background, so it reads the same in a light and a dark inbox. The everyday
// logo (logo_url) is dark artwork on transparent; a mail app in dark mode
// turns the white header dark behind it and the logo all but disappears.
//
// Fails soft: null means "no email logo", and the email keeps its plain
// header. A branding read must never stop a draft being written.

import { logError } from './log.js'

/**
 * @param {object} db          a supabase-js client (service role)
 * @param {string} locationId  the studio
 * @returns {Promise<string|null>} an https URL, or null
 */
export async function getEmailLogoUrl(db, locationId) {
  if (!db || !locationId) return null
  try {
    const { data, error } = await db
      .from('company_settings')
      .select('email_logo_url')
      .eq('location_id', locationId)
      .limit(1)
    if (error) {
      logError('email-logo', 'unreadable', { locationId, code: error.code ?? null })
      return null
    }
    const url = data?.[0]?.email_logo_url
    return typeof url === 'string' && /^https:\/\//i.test(url) ? url : null
  } catch {
    logError('email-logo', 'unresolved', { locationId })
    return null
  }
}
