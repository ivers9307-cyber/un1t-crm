// The "auto-create new leads in Glofox + attach trial" automation.
// qualifiesForGlofoxProvisioning is pure; maybeProvisionLeadInGlofox
// is the fire-and-forget hook the three lead-creation sites call in
// place of their old inline findOrCreateGlofoxMember dup-check.
//
// When the automation is OFF (or the lead is ineligible) behaviour is
// byte-identical to today: a link-only dup-check (createIfMissing:false).
// When ON + eligible: create-and-trial.

import { logWarn } from '@/lib/log'

const AUTOMATION_KEY = 'glofox_lead_provisioning'

/**
 * Pure eligibility check for a single contact row.
 * Excludes: already-linked, no-email, ClassPass shadows.
 * (Bulk-import + Glofox-sync paths are excluded by NOT calling the
 * hook at all — see the wiring task.)
 */
export function qualifiesForGlofoxProvisioning(contact) {
  if (!contact) return false
  if (contact.glofox_member_id) return false
  if (!contact.email) return false
  if (contact.source === 'classpass') return false
  return true
}

/**
 * Fire-and-forget. Never throws. Reads the per-location toggle, then
 * calls findOrCreateGlofoxMember in the right mode.
 *
 * @param {object}  args
 * @param {object}  args.db          service-role client
 * @param {string}  args.locationId
 * @param {object}  args.contact     the just-created contact row (needs id,email,glofox_member_id,location_id; name/first/last help)
 * @param {string}  args.source      label for glofox_push_events (e.g. 'manual','website_lead','assistant')
 * @param {Function} [args._findOrCreateGlofoxMember]  test seam
 */
export async function maybeProvisionLeadInGlofox({ db, locationId, contact, source, _findOrCreateGlofoxMember }) {
  try {
    if (!db || !locationId || !contact) return

    const findOrCreate = _findOrCreateGlofoxMember
      || (await import('@/lib/glofox-push')).findOrCreateGlofoxMember

    // Read the per-location toggle. Absent row = disabled.
    let enabled = false
    try {
      const { data } = await db
        .from('location_automations')
        .select('enabled')
        .eq('location_id', locationId)
        .eq('automation_key', AUTOMATION_KEY)
        .maybeSingle()
      enabled = Boolean(data?.enabled)
    } catch (e) {
      logWarn('automations.glofox-lead', 'toggle read failed; treating as disabled', { err: e })
      enabled = false
    }

    const create = enabled && qualifiesForGlofoxProvisioning(contact)

    await findOrCreate({
      db,
      locationId,
      contact,
      source: source || 'lead',
      createIfMissing: create,
      attachTrial: create,
    })
  } catch (e) {
    logWarn('automations.glofox-lead', 'provisioning hook failed', { err: e })
  }
}
