// Pure helpers for summarising event signups on the /events index.
//
// An event's registrations are team-shaped (race_registrations, one row
// per team — even a solo entry is a team of 1). The list historically
// showed only the confirmed REGISTRATION count, which understates the
// real headcount because allowed_team_sizes can be up to 8. These helpers
// surface both: people (sum of team sizes) AND signups (registration
// count), confirmed-only, so operators can watch headcount vs capacity.
//
// Pure (no DB, no network) so they unit-test under the Node env. The IO
// (the registrations embed incl. team size) lives in src/app/events/page.js.

/**
 * Count confirmed registrations as both headcount and registration count.
 * @param {Array<{status?:string, team?:{size?:number}|null}>|null|undefined} registrations
 * @returns {{people:number, signups:number}}
 */
export function computeSignupCounts(registrations) {
  const regs = Array.isArray(registrations) ? registrations : []
  let people = 0
  let signups = 0
  for (const reg of regs) {
    if (reg?.status !== 'confirmed') continue
    signups += 1
    const size = reg?.team?.size
    // A confirmed registration is always at least one person, even if the
    // team row / size is missing or invalid.
    people += Number.isFinite(size) && size > 0 ? size : 1
  }
  return { people, signups }
}

/**
 * Human summary for the Signups column, e.g. "35 people · 27 teams".
 * Leads with headcount (the capacity-relevant number); the registration
 * count is secondary and labelled per kind ("teams" for races, "signups"
 * otherwise, matching the Teams/Attendees terminology used elsewhere).
 * An optional event-level capacity is appended to the signup count to
 * preserve the prior "27 / 40" behaviour.
 * @param {Array} registrations
 * @param {{isRace?:boolean, capacity?:number|null}} [opts]
 * @returns {string}
 */
export function formatSignupSummary(registrations, { isRace = false, capacity = null } = {}) {
  const { people, signups } = computeSignupCounts(registrations)
  const peopleNoun = people === 1 ? 'person' : 'people'
  const unit = isRace
    ? (signups === 1 ? 'team' : 'teams')
    : (signups === 1 ? 'signup' : 'signups')
  const cap = Number.isFinite(capacity) && capacity > 0 ? ` / ${capacity}` : ''
  return `${people} ${peopleNoun} · ${signups}${cap} ${unit}`
}
