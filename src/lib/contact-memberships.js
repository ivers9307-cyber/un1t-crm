// HATCH-MEMBERS.1 (mig 722) — memberships held outside Glofox, for display.
//
// contact_memberships is written by the operator-run import of a studio's
// own client export (today: Hatch Street's un1t.online export). Event member
// pricing reads it in member-validation.js; this module only serves the
// contact page.

export const MEMBERSHIP_SOURCE_LABELS = Object.freeze({
  un1t_online_export: 'un1t.online',
})

/**
 * Every membership row for one contact, active first, with its studio name.
 * The caller has already authorised the contact (canViewContact). A failed
 * read returns [] with the error, never throws: a profile must not blank.
 *
 * @returns {Promise<{ rows: Array<object>, error: object|null }>}
 */
export async function loadContactMemberships(db, contactId) {
  if (!db || !contactId) return { rows: [], error: null }
  const { data, error } = await db
    .from('contact_memberships')
    .select('id, plan_name, status, source, last_seen_at, ended_at, location_id, locations:location_id ( name )')
    .eq('contact_id', contactId)
    .order('status', { ascending: true })
    .order('last_seen_at', { ascending: false })
    .limit(20)
  if (error) return { rows: [], error }
  return { rows: Array.isArray(data) ? data : [], error: null }
}
