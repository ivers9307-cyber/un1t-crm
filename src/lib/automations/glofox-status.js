// PROFILESPREAD.1 (F6) — is Glofox connected at this location, for the
// automations pages. They used to read it off user.activeLocation.settings,
// which is why the user object (serialised into EVERY page) had to carry the
// location's settings, including the customer agent's test phone numbers. It
// now carries none; these two pages read settings themselves, by id, with the
// service role, and hand the client BOOLEANS only.
//
// A failed read is UNKNOWN, never "not connected": a blip must not tell an
// operator their integration is gone. The pages show a "Couldn't check"
// notice and keep the enable toggles off until a reload.

import { AUTOMATIONS, automationStatus, glofoxConnected } from './registry.js'
import { logError } from '@/lib/log'

const unknownStatuses = () =>
  Object.fromEntries(AUTOMATIONS.map((a) => [a.key, { available: false, trialConfigured: false, unknown: true }]))

const knownStatuses = (location) =>
  Object.fromEntries(AUTOMATIONS.map((a) => [a.key, automationStatus(a.key, location)]))

/**
 * @param {object} db  service-role client
 * @param {string|null|undefined} locationId
 * @returns {Promise<{ known: boolean, connected: boolean|null, statuses: Record<string, { available: boolean, trialConfigured: boolean, unknown?: true }> }>}
 */
export async function readGlofoxAutomationStatus(db, locationId) {
  if (!locationId) return { known: true, connected: false, statuses: knownStatuses(null) }
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
    return { known: false, connected: null, statuses: unknownStatuses() }
  }
  const location = { settings: data.settings || {} }
  return { known: true, connected: glofoxConnected(location), statuses: knownStatuses(location) }
}
