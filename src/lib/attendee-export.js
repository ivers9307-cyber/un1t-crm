// Shared attendee-export helpers (EVENTS-EXPORT.1 + HOST-PORTAL.1).
//
// The attendee CSV download is offered on two surfaces that must produce a
// byte-identical file:
//   - staff events UI   → /api/events/[id]/teams/export       (races perm + location gate)
//   - host portal        → /api/host/events/[id]/attendees/export (getCurrentHost + host_id)
// The ONLY difference between the callers is the auth/tenancy gate; the fetch
// and the CSV Response live here once so they can never drift apart.

import { buildAttendeeCsv } from '@/lib/attendee-csv'

const PAGE = 1000
// UTF-8 BOM so Excel renders accented names correctly.
const BOM = '﻿'

/**
 * Pick the latest NON-EMPTY contact phone per registration from payment rows
 * ordered created_at DESC. A later attempt that dropped the phone must not blank
 * an earlier good one, so we keep the first non-empty seen per registration.
 * Pure — unit-testable without a DB.
 * @param {Array<{race_registration_id:string, contact_phone:string|null}>} payments  (created_at DESC)
 * @returns {Record<string,string>}
 */
export function pickLatestPhones(payments) {
  const byReg = {}
  for (const pmt of (payments || [])) {
    if (!byReg[pmt.race_registration_id] && pmt.contact_phone) {
      byReg[pmt.race_registration_id] = pmt.contact_phone
    }
  }
  return byReg
}

/**
 * Fetch an event's registrations (with team members + wave) and attach each
 * registration's latest booking phone. Range-paginated so a large event never
 * silently truncates at the 1000-row select cap. Service-role client; the
 * CALLER is responsible for the tenancy gate before calling this.
 * @returns {Promise<Array>} registrations ready for buildAttendeeCsv
 */
export async function fetchEventAttendees(db, eventId) {
  const regs = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('race_registrations')
      .select(`
        id, status, registered_at, wave_id,
        teams:team_id ( id, name, size, team_members ( id, name, email, role, is_member ) ),
        wave:wave_id ( id, start_time, label )
      `)
      .eq('race_event_id', eventId)
      .order('registered_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`attendee export: registrations query failed: ${error.message}`)
    regs.push(...(data || []))
    if (!data || data.length < PAGE) break
  }

  // Attach the latest payment's contact phone per registration (the only phone
  // captured — individual team members don't have their own). Best-effort: a
  // payments-query error just leaves phones blank rather than failing the export.
  const regIds = regs.map((r) => r.id)
  if (regIds.length > 0) {
    const payments = []
    for (let from = 0; ; from += PAGE) {
      const { data } = await db
        .from('race_payments')
        .select('race_registration_id, contact_phone, created_at')
        .in('race_registration_id', regIds)
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)
      payments.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
    const phoneByReg = pickLatestPhones(payments)
    for (const r of regs) r.payment = { contact_phone: phoneByReg[r.id] || null }
  }
  return regs
}

/**
 * Build the CSV download Response for an event's attendees — byte-identical
 * across the staff + host surfaces.
 * @param {{name:string, slug?:string, race_date:string|null}} race
 * @param {Array} regs  from fetchEventAttendees
 */
export function attendeeCsvResponse(race, regs) {
  const csv = buildAttendeeCsv({ name: race.name, race_date: race.race_date }, regs)
  const safe = String(race.slug || race.name || 'event')
    .replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'event'

  return new Response(BOM + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}-attendees.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
