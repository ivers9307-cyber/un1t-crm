// TRIALSTUDIO.3 — the eligibility reads behind the public /trial routes.
//
// Stillorgan (Glofox) must refuse a buyer who has already had a trial BEFORE
// money is taken; Hatch Street (un1t.online) refuses only a buyer with an
// active membership. Reads only: no HTTP, no alerts, no writes. Every read is
// scoped to the studio's location id, so a trial at a sibling studio never
// counts. A read that fails is { ok: false } and the caller treats it as
// "cannot tell", never as a verdict either way.
//
// Logs carry ids only (location, contact), never a name, email or phone.
import { logWarn } from '@/lib/log'
import { MEMBERSHIP_ACTIVE_STATUSES } from '@/lib/un1t-online-map'

const TRIAL_STATUSES = new Set(['trial', 'no_sale_trial'])
const TRIAL_PLAN = /trial/i

// One existence read. Resolves { ok: true, found } or { ok: false, reason }.
// `build` receives the table's query builder (already select()ed and scoped by
// location) and adds the signal's own filters. A supabase builder is a
// thenable with no .catch, so a thrown read is caught with try/await.
async function exists(db, table, { locationId, contactId, columns = 'id', build }) {
  try {
    const q = db.from(table).select(columns).eq('location_id', locationId)
    const { data, error } = await build(q).limit(1)
    if (error) {
      logWarn('trial-eligibility', `${table} read failed`, { table, locationId, contactId })
      return { ok: false, reason: `${table}_unreadable` }
    }
    return { ok: true, found: Array.isArray(data) && data.length > 0, row: data?.[0] ?? null }
  } catch {
    logWarn('trial-eligibility', `${table} read threw`, { table, locationId, contactId })
    return { ok: false, reason: `${table}_unreadable` }
  }
}

// Has this contact already had a trial at this Stillorgan location? Signals,
// in order: the contact's own columns (no read), a live Glofox trial claim, an
// account created with the trial attached, a granted paid trial.
export async function stillorganTrialHistory(db, { locationId, contact }) {
  const reasons = []
  const status = contact?.glofox_membership_status
  if (TRIAL_STATUSES.has(status)) reasons.push(`membership_status=${status}`)
  if (TRIAL_PLAN.test(contact?.glofox_membership_plan || '')) reasons.push('membership_plan_trial')

  const contactId = contact?.id ?? null
  const memberId = contact?.glofox_member_id ?? null

  if (memberId) {
    const claim = await exists(db, 'glofox_trial_claims', {
      locationId, contactId,
      build: (q) => q.eq('glofox_member_id', memberId).is('released_at', null),
    })
    if (!claim.ok) return claim
    if (claim.found) reasons.push('glofox_trial_claim')
  }

  const push = await exists(db, 'glofox_push_events', {
    locationId, contactId,
    build: (q) => q.eq('contact_id', contactId).eq('status', 'created'),
  })
  if (!push.ok) return push
  if (push.found) reasons.push('glofox_push_created')

  const paid = await exists(db, 'trial_purchases', {
    locationId, contactId,
    build: (q) => q.eq('contact_id', contactId).eq('status', 'granted'),
  })
  if (!paid.ok) return paid
  if (paid.found) reasons.push('paid_trial_granted')

  return { ok: true, hadTrial: reasons.length > 0, reasons }
}

// Does this contact hold an active membership at this Hatch Street location?
export async function hatchActiveMembership(db, { locationId, contactId }) {
  const reasons = []

  const sub = await exists(db, 'un1t_subscriptions', {
    locationId, contactId, columns: 'id, status',
    build: (q) => q.eq('contact_id', contactId).in('status', [...MEMBERSHIP_ACTIVE_STATUSES]),
  })
  if (!sub.ok) return sub
  if (sub.found) reasons.push(`un1t_subscription=${sub.row?.status ?? 'active'}`)

  const membership = await exists(db, 'contact_memberships', {
    locationId, contactId,
    build: (q) => q.eq('contact_id', contactId).eq('status', 'active').is('ended_at', null),
  })
  if (!membership.ok) return membership
  if (membership.found) reasons.push('contact_membership_active')

  return { ok: true, active: reasons.length > 0, reasons }
}

// 'trial_used: a, b' / 'active_member: a' — the text stored in last_error.
export function reasonsText(reasons, prefix = 'trial_used') {
  return `${prefix}: ${(reasons || []).join(', ')}`
}
