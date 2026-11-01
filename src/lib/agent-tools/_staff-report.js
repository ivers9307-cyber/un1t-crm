// MCP.1 — the per-person aggregation behind `staff_hours_report` and
// `staff_cost_report`. Not a tool (tests/agent-tools-guard.test.js NOT_TOOLS).
//
// Copied from the in-app assistant's `generate_report`
// (src/app/api/assistant/chat/route.js), which stays as it is for now; the
// follow-up that moves the assistant onto the registry removes the copy.
// Differences from the original: rows are grouped by profile id (two people
// with one name used to merge), figures are numbers, and a failed read throws
// (the registry logs it and answers `tool_failed`) instead of returning an
// error object a client could read as "no hours".
//
// Hours are `shiftHours()`: override, then the block's own time, then the
// template's, the figure the calendar and the Reporting tab show.

import { fetchScheduledShiftRows } from '@/lib/report-generator'
import { shiftHours } from '@/lib/payroll'

const MAX_ROWS = 50
const round1 = (n) => Math.round(n * 10) / 10
const round2 = (n) => Math.round(n * 100) / 100

async function loadShifts(db, { locationId, start, end }) {
  const { rows, error } = await fetchScheduledShiftRows(db, { locationId, periodStart: start, periodEnd: end })
  if (error) throw new Error(error)
  return rows || []
}

/** Hours per person for the studio over [start, end]. No pay. */
export async function staffHoursReport(db, { locationId, start, end }) {
  const shifts = await loadShifts(db, { locationId, start, end })
  const byProfile = new Map()
  for (const s of shifts) {
    const entry = byProfile.get(s.profile_id) ?? { profile_id: s.profile_id, name: s.profiles?.full_name || 'Unknown', hours: 0 }
    entry.hours += shiftHours(s)
    byProfile.set(s.profile_id, entry)
  }
  const staff = [...byProfile.values()]
    .map((e) => ({ ...e, hours: round1(e.hours) }))
    .sort((a, b) => b.hours - a.hours)
  return {
    report: 'Staff Hours Worked',
    period: { start, end },
    staff: staff.slice(0, MAX_ROWS),
    total_hours: round1(staff.reduce((sum, r) => sum + r.hours, 0)),
    capped: staff.length > MAX_ROWS,
  }
}

/** Hours, hourly rate and cost per person. Pay figures: owner, manager and master only (the tool's gate). */
export async function staffCostReport(db, { locationId, start, end }) {
  // Rates only for active people who work at this studio: an unscoped profiles
  // read would hand over every tenant's pay.
  const { data: links, error: linksError } = await db.from('profile_locations')
    .select('profile_id')
    .eq('location_id', locationId)
  if (linksError) throw new Error(`Failed to load staff: ${linksError.message}`)
  const profileIds = [...new Set((links || []).map((l) => l.profile_id))]

  let profiles = []
  if (profileIds.length > 0) {
    const { data, error } = await db.from('profiles')
      .select('id, full_name, employment_type, annual_salary, hourly_rate, contracted_hours_per_week')
      .in('id', profileIds)
      .eq('active', true)
    if (error) throw new Error(`Failed to load staff rates: ${error.message}`)
    profiles = data || []
  }

  const rates = new Map()
  for (const p of profiles) {
    let rate = 0
    if (p.employment_type === 'contractor') rate = Number(p.hourly_rate) || 0
    else if (p.annual_salary && p.contracted_hours_per_week) rate = Number(p.annual_salary) / (Number(p.contracted_hours_per_week) * 52)
    rates.set(p.id, { name: p.full_name, rate: round2(rate) })
  }

  const shifts = await loadShifts(db, { locationId, start, end })
  const byProfile = new Map()
  for (const s of shifts) {
    const person = rates.get(s.profile_id)
    if (!person) continue
    const entry = byProfile.get(s.profile_id) ?? { profile_id: s.profile_id, name: person.name, hours: 0, hourly_rate: person.rate, cost: 0 }
    const hours = shiftHours(s)
    entry.hours += hours
    entry.cost += hours * person.rate
    byProfile.set(s.profile_id, entry)
  }
  const staff = [...byProfile.values()]
    .map((e) => ({ ...e, hours: round1(e.hours), cost: round2(e.cost) }))
    .sort((a, b) => b.cost - a.cost)
  return {
    report: 'Staff Cost Breakdown',
    period: { start, end },
    currency: 'EUR',
    staff: staff.slice(0, MAX_ROWS),
    total_cost: round2(staff.reduce((sum, r) => sum + r.cost, 0)),
    capped: staff.length > MAX_ROWS,
  }
}
