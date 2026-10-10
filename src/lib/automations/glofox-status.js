// PROFILESPREAD.1 (F6) — is Glofox connected at this location, for the
// automations pages. They used to read it off the settings of the user
// object's active location, which is why the user object (serialised into EVERY page) had to carry the
// location's settings, including the customer agent's test phone numbers. It
// now carries none; these two pages read settings themselves, by id, with the
// service role, and hand the client BOOLEANS only.
//
// W1.M3a — "connected" is no longer inferred from the settings slice: it is
// locations.membership_source resolved through membershipStateForPage()
// (configured = the chosen source has its credentials). The slice is still
// read, for the trial configuration the lead-provisioning card shows. The
// result carries `membership` so a page can render <MembershipSourceGate>
// from the same read.
//
// A failed read — of EITHER the membership state or the slice — is UNKNOWN,
// never "not connected": a blip must not tell an operator their integration
// is gone. The pages show a "Couldn't check" notice and keep the enable
// toggles off until a reload.

import { AUTOMATIONS, automationStatus } from './registry.js'
import { membershipStateForPage } from '@/lib/membership/state-for-page'
import { logError } from '@/lib/log'

const unknownStatuses = () =>
  Object.fromEntries(AUTOMATIONS.map((a) => [a.key, { available: false, trialConfigured: false, unknown: true }]))

const knownStatuses = (location, connected) =>
  Object.fromEntries(AUTOMATIONS.map((a) => [a.key, automationStatus(a.key, location, { connected })]))

async function readSettings(db, locationId) {
  let data = null
  let error = null
  try {
    ;({ data, error } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle())
  } catch (e) {
    error = { code: e?.code || 'THROWN' }
  }
  if (error || !data) {
    logError('automations/glofox-status', 'location settings read failed; Glofox status unknown', {
      locationId,
      code: error?.code || (data ? null : 'NO_ROW'),
    })
    return null
  }
  return { settings: data.settings || {} }
}

/**
 * @param {object} db  service-role client
 * @param {string|null|undefined} locationId
 * @returns {Promise<{ known: boolean, connected: boolean|null, membership: object, statuses: Record<string, { available: boolean, trialConfigured: boolean, unknown?: true }> }>}
 */
export async function readGlofoxAutomationStatus(db, locationId) {
  if (!locationId) {
    const membership = await membershipStateForPage(db, null)
    return { known: true, connected: false, membership, statuses: knownStatuses(null, false) }
  }
  const [membership, location] = await Promise.all([
    membershipStateForPage(db, locationId),
    readSettings(db, locationId),
  ])
  if (membership.state === 'unknown' || !location) {
    return { known: false, connected: null, membership, statuses: unknownStatuses() }
  }
  const connected = membership.state === 'configured'
  return { known: true, connected, membership, statuses: knownStatuses(location, connected) }
}
