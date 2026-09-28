// ROLESWEEP.1c — the contact page's server-side DATA gates, judged at the
// CONTACT's location.
//
// The contact page (src/app/(sales)/contacts/[id]/page.js) renders through
// createServerClient() (service role, so RLS does not bind it): these checks
// ARE the access gate for what it loads. hasPermission(user, …) resolves at
// the ACTIVE studio, so a caller whose consultations toggle is on at their
// active studio and off at the contact's would have had that contact's
// consultations, goals, photos and scans loaded into the page. Every decision
// here is made at the contact's location instead.
import { hasPermissionForLocation, hasMobilePermissionForLocation } from './permissions'

/**
 * May the page load this contact's consultations, coaching goals,
 * consultation photos and InBody scans? The `consultations` permission at the
 * contact's location, the same decision the /api/contacts/[id]/consultations
 * family makes.
 *
 * @param {object|null} user        getCurrentUser() result
 * @param {string|null} locationId  the contact's location_id
 * @returns {boolean}
 */
export function canLoadContactConsultations(user, locationId) {
  return hasPermissionForLocation(user, locationId, 'consultations')
}

/**
 * The composer's channel flags for a contact: WhatsApp, SMS and email, each
 * the web OR the mobile toggle at the contact's location. That is exactly the
 * decision the send routes (/api/contacts/[id]/whatsapp, /sms, /email) make,
 * so a composer never offers a channel the send route would refuse, nor hides
 * one it would accept. The contact page and the pipeline drawer
 * (/api/contacts/[id]/command-centre?scope=drawer) both read these; `whatsapp`
 * also gates the page's and the drawer's WhatsApp template read.
 *
 * @param {object|null} user
 * @param {string|null} locationId  the contact's location_id
 * @returns {{ whatsapp: boolean, sms: boolean, email: boolean }}
 */
export function contactChannelFlags(user, locationId) {
  const at = (key) =>
    hasPermissionForLocation(user, locationId, key) || hasMobilePermissionForLocation(user, locationId, key)
  return { whatsapp: at('whatsapp'), sms: at('sms'), email: at('email') }
}
