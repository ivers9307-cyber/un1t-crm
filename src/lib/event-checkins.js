// Pure helpers for event check-in / attendance (EVENT-CHECKIN.A).
//
// Attendance is per-person: each team_member of a confirmed registration is
// either checked in or not. These helpers count heads for the live "X / Y
// people in" display and summarise a single registration for the roster UI.
// A confirmed registration with no member rows still represents one person
// (the registrant), so it counts as 1 expected.
//
// Pure (no DB/network) so they unit-test under Node. IO (reading race_checkins
// + stamping `checked_in` onto each member) lives in the check-in API + page.

function membersOf(registration) {
  const members = registration?.team?.team_members
  return Array.isArray(members) ? members : []
}

/**
 * Headcount across confirmed registrations: how many people are checked in
 * vs how many are expected. Confirmed-only.
 * @param {Array} registrations  each: { status, team: { team_members: [{ checked_in }] } }
 * @returns {{present:number, expected:number}}
 */
export function checkinCounts(registrations) {
  const regs = Array.isArray(registrations) ? registrations : []
  let present = 0
  let expected = 0
  for (const r of regs) {
    if (r?.status !== 'confirmed') continue
    const members = membersOf(r)
    if (members.length === 0) { expected += 1; continue }
    for (const m of members) {
      expected += 1
      if (m?.checked_in) present += 1
    }
  }
  return { present, expected }
}

/**
 * Attendance state for a single registration, for the roster row UI.
 * @param {object} registration
 * @returns {{present:number, expected:number, allPresent:boolean, nonePresent:boolean}}
 */
export function registrationAttendance(registration) {
  const members = membersOf(registration)
  if (members.length === 0) {
    return { present: 0, expected: 1, allPresent: false, nonePresent: true }
  }
  let present = 0
  for (const m of members) if (m?.checked_in) present += 1
  const expected = members.length
  return {
    present,
    expected,
    allPresent: present === expected,
    nonePresent: present === 0,
  }
}

const firstName = (s) => String(s || '').trim().toLocaleLowerCase('en-IE')

/**
 * CHECKINLAYOUT.1 — the door roster, shaped for the check-in page: entries
 * sorted by their first person's name, grouped by start time when the event
 * has more than one, filtered by the tab and the search. Pure.
 *
 * Counts (overall and per time) always cover every person, whatever the tab
 * or search, so a header reads "3 of 10 in" even while only the 7 still to
 * arrive are listed.
 *
 * @param {Array<{ id, wave_id?, wave_label?, wave_time?, _order?, team: { name, team_members: Array<{ id, name, email?, checked_in }> } }>} registrations
 * @param {{ tab?: 'arrive'|'in'|'all', query?: string }} [opts]
 * @returns {{ grouped: boolean, present: number, expected: number, toArrive: number,
 *   groups: Array<{ key: string, label: string|null, time: string|null, present: number, expected: number,
 *     entries: Array<{ reg: object, members: Array<object & { emailMatch: boolean }> }> }> }}
 */
export function buildCheckinView(registrations, { tab = 'arrive', query = '' } = {}) {
  const regs = Array.isArray(registrations) ? registrations : []
  const q = String(query || '').trim().toLocaleLowerCase('en-IE')
  const waveKeys = new Set(regs.map((r) => r.wave_id || ''))
  const grouped = waveKeys.size > 1

  const groups = new Map()
  let present = 0
  let expected = 0
  const sorted = [...regs].sort((a, b) =>
    (a._order ?? 999) - (b._order ?? 999)
    || String(a.wave_time || '').localeCompare(String(b.wave_time || ''))
    || String(a.wave_id || '').localeCompare(String(b.wave_id || ''))
    || firstName(membersOf(a)[0]?.name || a.team?.name).localeCompare(firstName(membersOf(b)[0]?.name || b.team?.name), 'en-IE'))

  for (const reg of sorted) {
    const key = grouped ? (reg.wave_id || '') : 'all'
    if (!groups.has(key)) {
      groups.set(key, { key, label: grouped ? (reg.wave_label || null) : null, time: grouped ? (reg.wave_time || null) : null, present: 0, expected: 0, entries: [] })
    }
    const g = groups.get(key)
    const members = membersOf(reg)
    for (const m of members) {
      g.expected += 1
      expected += 1
      if (m?.checked_in) { g.present += 1; present += 1 }
    }

    const teamMatch = q && String(reg.team?.name || '').toLocaleLowerCase('en-IE').includes(q)
    const visible = members
      .filter((m) => (tab === 'arrive' ? !m.checked_in : tab === 'in' ? !!m.checked_in : true))
      .map((m) => {
        const email = String(m.email || '').toLocaleLowerCase('en-IE')
        const nameMatch = !q || String(m.name || '').toLocaleLowerCase('en-IE').includes(q)
        const emailMatch = !!q && email.includes(q)
        return { ...m, emailMatch, _match: !q || teamMatch || nameMatch || emailMatch }
      })
      .filter((m) => m._match)
      .map(({ _match, ...m }) => m)
    if (visible.length) g.entries.push({ reg, members: visible })
  }

  return { grouped, present, expected, toArrive: expected - present, groups: [...groups.values()] }
}

/**
 * Which start time opens on its own: the first one with anyone still to
 * arrive (so finished waves fold away), else the first. Pure.
 */
export function defaultOpenGroup(groups) {
  const list = Array.isArray(groups) ? groups : []
  return (list.find((g) => g.present < g.expected) || list[0])?.key ?? null
}
