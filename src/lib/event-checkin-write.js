// Shared check-in writes (EVENT-CHECKIN.A; host check-in HOSTCHECKIN.1).
//
// The staff routes (/api/events/[id]/checkin, /all) and the host routes
// (/api/host/events/[id]/checkin, /all) resolve the person the same way and
// write the same race_checkins rows, so a check-in means one thing whoever
// taps it. Gating stays in each route: staff by `races` at the event's
// studio, hosts by owning the event.
import { followPlacementForCheckin, isPlacedRedirect } from './placed-checkin'

// Load the registration, confirm it belongs to THIS event, and locate the
// member on its team. Returns { error, status } or
// { member, locationId, registrationId }.
//
// FINDTEAM.8 (I2): a placed solo row is followed to the team entry it joined
// (placed_into_registration_id) and the person's member row THERE (by
// contact, else email), so check-in and its undo land on the team, never on
// the dead solo row. registrationId is the row the check-in belongs to.
export async function resolveCheckinTarget(db, eventId, registrationId, memberId) {
  const { data: reg, error: regErr } = await db
    .from('race_registrations')
    .select('id, race_event_id, status, contact_id, placed_into_registration_id, race_events!inner ( id, location_id, host_id ), teams ( id, team_members ( id, email, contact_id ) )')
    .eq('id', registrationId)
    .maybeSingle()
  if (regErr) return { error: 'Could not read the registration', status: 500 }
  if (!reg || reg.race_event_id !== eventId) {
    return { error: 'Registration not found for this event', status: 404 }
  }
  const locationId = reg.race_events?.location_id
  const member = (reg.teams?.team_members || []).find((m) => m.id === memberId)
  if (!member) return { error: 'That person is not on this registration', status: 400 }
  const hostId = reg.race_events?.host_id || null
  if (!isPlacedRedirect(reg)) return { member, locationId, hostId, registrationId, registrationStatus: reg.status }
  const followed = await followPlacementForCheckin(db, {
    eventId,
    placedIntoId: reg.placed_into_registration_id,
    person: { contact_id: member.contact_id || reg.contact_id || null, email: member.email },
  })
  if (!followed.ok) {
    if (followed.reason === 'load_failed') return { error: 'Could not read the registration', status: 500 }
    if (followed.reason === 'not_found') return { error: 'Registration not found for this event', status: 404 }
    return { error: 'That person is not on this registration', status: 400 }
  }
  return { member: followed.member, locationId, hostId, registrationId: followed.registrationId, registrationStatus: followed.registrationStatus }
}


/**
 * The confirmed door roster of one event, shaped for EventCheckinClient:
 * registrations (confirmed only) with each member's checked_in from
 * race_checkins, wave label/time/order, sorted by wave then team name.
 * `race` carries `waves` and `registrations` (id, status, wave_id,
 * teams ( id, name, team_members ( id, name, email ) )) as both check-in pages
 * select them. Reads race_checkins; returns { rows } or { error }.
 *
 * CHECKINPAID.1 — `{ withPaid: true }` also stamps what each person paid
 * (paidByMember below); the registrations then need contact_id and
 * placed_into_registration_id, and team_members contact_id.
 */
export async function loadCheckinRoster(db, race, { withPaid = false } = {}) {
  const confirmed = (race?.registrations || []).filter((r) => r.status === 'confirmed')
  const regIds = confirmed.map((r) => r.id)
  let paid = new Map()
  if (withPaid && race?.id) {
    const payments = []
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from('race_payments')
        .select('id, race_registration_id, amount_cents, refunded_amount_cents, currency, contact_id, contact_email')
        .eq('race_event_id', race.id)
        .eq('status', 'completed')
        .order('id')
        .range(from, from + 999)
      if (error) return { error }
      payments.push(...(data || []))
      if (!data || data.length < 1000) break
    }
    paid = paidByMember(race.registrations || [], payments)
  }
  const checked = new Set()
  for (let i = 0; i < regIds.length; i += 200) {
    const { data, error } = await db
      .from('race_checkins')
      .select('race_registration_id, team_member_id')
      .in('race_registration_id', regIds.slice(i, i + 200))
    if (error) return { error }
    for (const c of data || []) checked.add(`${c.race_registration_id}:${c.team_member_id}`)
  }

  const wavesById = new Map((race?.waves || []).map((w) => [w.id, w]))
  const rows = confirmed
    .map((r) => {
      const w = wavesById.get(r.wave_id)
      const time = w?.start_time ? String(w.start_time).slice(0, 5) : null
      return {
        id: r.id,
        wave_id: r.wave_id,
        wave_label: w ? (w.label || time) : null,
        wave_time: time,
        _order: w?.display_order ?? 999,
        team: {
          id: r.teams?.id || null,
          name: r.teams?.name || 'Entry',
          team_members: (r.teams?.team_members || []).map((m) => ({
            id: m.id,
            name: m.name || m.email || 'Member',
            email: m.email || null,
            checked_in: checked.has(`${r.id}:${m.id}`),
            ...(withPaid ? paidFields(paid.get(`${r.id}:${m.id}`)) : {}),
          })),
        },
      }
    })
    .sort((a, b) => a._order - b._order || a.team.name.localeCompare(b.team.name))
  return { rows }
}

function paidFields(p) {
  return p ? { paid_cents: p.cents, paid_for: p.people, paid_currency: p.currency } : { paid_cents: null, paid_for: null, paid_currency: null }
}

const lower = (s) => String(s ?? '').trim().toLowerCase()

function findMember(members, { contactId, email }) {
  let m = contactId ? members.find((x) => x.contact_id && x.contact_id === contactId) : null
  const e = lower(email)
  if (!m && e) m = members.find((x) => lower(x.email) === e)
  return m || null
}

/**
 * CHECKINPAID.1 — who paid what, keyed `${registrationId}:${memberId}` on the
 * door roster. Completed payments only, less anything refunded; a booking's
 * payments (entry and any date-change top-up) are added together.
 *
 * - A confirmed booking's money sits beside the person who paid it (matched
 *   on the payment's contact, else email; else the booking's contact; else
 *   the first name), with `people` = everyone on that booking.
 * - A placed solo ("Find me a team") keeps the payment on their own row: it
 *   is followed to the team entry they joined and set beside their name
 *   there, the same contact-then-email match the check-in uses.
 *
 * Returns Map<key, { cents, people, currency }>.
 */
export function paidByMember(registrations, payments) {
  const byReg = new Map()
  for (const p of payments || []) {
    if (!p?.race_registration_id) continue
    const net = Math.max(0, (Number(p.amount_cents) || 0) - (Number(p.refunded_amount_cents) || 0))
    const cur = byReg.get(p.race_registration_id) || { cents: 0, currency: p.currency || 'EUR', payer: null }
    cur.cents += net
    if (!cur.payer && (p.contact_id || p.contact_email)) cur.payer = { contactId: p.contact_id || null, email: p.contact_email || null }
    byReg.set(p.race_registration_id, cur)
  }

  const regs = Array.isArray(registrations) ? registrations : []
  const confirmedById = new Map(regs.filter((r) => r.status === 'confirmed').map((r) => [r.id, r]))
  const out = new Map()
  const add = (key, cents, people, currency) => {
    const prev = out.get(key)
    out.set(key, prev ? { cents: prev.cents + cents, people: Math.max(prev.people, people), currency: prev.currency } : { cents, people, currency })
  }

  for (const r of regs) {
    const pay = byReg.get(r.id)
    if (!pay || pay.cents <= 0) continue
    const own = r.teams?.team_members || []
    if (r.status === 'confirmed') {
      if (!own.length) continue
      const who = (pay.payer && findMember(own, pay.payer))
        || (r.contact_id && findMember(own, { contactId: r.contact_id }))
        || own[0]
      add(`${r.id}:${who.id}`, pay.cents, own.length, pay.currency)
    } else if (r.status === 'placed') {
      const target = confirmedById.get(r.placed_into_registration_id)
      if (!target) continue
      const solo = own[0] || {}
      const who = findMember(target.teams?.team_members || [], {
        contactId: solo.contact_id || r.contact_id || pay.payer?.contactId || null,
        email: solo.email || pay.payer?.email || null,
      })
      if (who) add(`${target.id}:${who.id}`, pay.cents, 1, pay.currency)
    }
  }
  return out
}
