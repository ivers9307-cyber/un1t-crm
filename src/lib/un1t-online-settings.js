// UN1TWRITE.4 — the per-location un1t.online write settings.
//
// Where they live: locations.settings.un1t_online.* (the Settings, Integrations,
// un1t.online tab writes them through mergeLocationSettings; plan D Tasks 11
// and 25). Both switches are master-only and default OFF:
//   writes_enabled   every write primitive refuses UN1T_WRITES_OFF without it.
//   funnel_enabled   moves the public path to un1t.online; counts ONLY when
//                    writes_enabled is also true.
// A missing key, a string "true", 1, {} ... are all OFF: only the literal
// boolean true turns anything on. A flag that fails closed is the point.

import { parseHiddenKeywords } from './class-keywords'

export class Un1tSettingsReadError extends Error {
  /** @param {string} message @param {{ code?: string|null }} [opts] */
  constructor(message, { code = null } = {}) {
    super(message)
    this.name = 'Un1tSettingsReadError'
    this.code = code
  }
}

const isTrue = (v) => v === true

/**
 * Pure. `settings` is the WHOLE locations.settings object (the same shape
 * mergeLocationSettings hands its mutator); anything unreadable is all-off.
 *
 * @returns {{ writesEnabled: boolean, funnelEnabled: boolean, trialProductId: string|null,
 *   hiddenClassKeywords: string[], sendsWelcome: boolean, welcomeSetsLogin: boolean,
 *   sendsBookingConfirmation: boolean }}
 */
export function un1tWriteSettingsFrom(settings) {
  const block =
    settings && typeof settings === 'object' && settings.un1t_online && typeof settings.un1t_online === 'object'
      ? settings.un1t_online
      : {}
  const writesEnabled = isTrue(block.writes_enabled)
  const trial = typeof block.trial_product_id === 'string' ? block.trial_product_id.trim() : ''
  return {
    writesEnabled,
    funnelEnabled: writesEnabled && isTrue(block.funnel_enabled),
    trialProductId: trial || null,
    hiddenClassKeywords: parseHiddenKeywords(block.hidden_class_keywords),
    sendsWelcome: isTrue(block.un1t_sends_welcome),
    welcomeSetsLogin: isTrue(block.un1t_welcome_sets_login),
    sendsBookingConfirmation: isTrue(block.un1t_sends_booking_confirmation),
  }
}

/**
 * Read a location's write settings and the facts every write needs.
 * Throws Un1tSettingsReadError on a database error, a thrown client or a
 * missing row: an unreadable switch must never read as "off, carry on" (the
 * queue's retry is the signal) and never as "on".
 *
 * @returns {Promise<{ membershipSource: string|null, studioName: string|null,
 *   organizationId: string|null, settings: ReturnType<typeof un1tWriteSettingsFrom> }>}
 */
export async function readUn1tWriteSettings(db, locationId) {
  if (!locationId) throw new Un1tSettingsReadError('un1t.online settings read needs a location id')
  let res
  try {
    res = await db
      .from('locations')
      .select('id, name, organization_id, membership_source, settings')
      .eq('id', locationId)
      .maybeSingle()
  } catch (err) {
    throw new Un1tSettingsReadError(`un1t.online settings read threw (${err?.name ?? 'Error'})`)
  }
  const { data, error } = res
  if (error) {
    throw new Un1tSettingsReadError(`un1t.online settings read failed (${error.code ?? 'no code'})`, { code: error.code ?? null })
  }
  if (!data) throw new Un1tSettingsReadError('un1t.online settings read found no location row')
  return {
    membershipSource: data.membership_source ?? null,
    studioName: data.name ?? null,
    organizationId: data.organization_id ?? null,
    settings: un1tWriteSettingsFrom(data.settings),
  }
}
