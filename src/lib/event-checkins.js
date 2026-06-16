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
