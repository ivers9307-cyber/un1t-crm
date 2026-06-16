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
 * Leads with headcount; the registration count is secondary and labelled
 * per kind ("teams" for races, "signups" otherwise). When an event-level
 * capacity is supplied it is shown against the unit the event caps on:
 * people mode -> "35 / 40 people · 27 teams"; teams mode (default) ->
 * "35 people · 27 / 40 teams".
 * @param {Array} registrations
 * @param {{isRace?:boolean, capacity?:number|null, mode?:'teams'|'people'}} [opts]
 * @returns {string}
 */
export function formatSignupSummary(registrations, { isRace = false, capacity = null, mode = 'teams' } = {}) {
  const { people, signups } = computeSignupCounts(registrations)
  const peopleNoun = people === 1 ? 'person' : 'people'
  const unit = isRace
    ? (signups === 1 ? 'team' : 'teams')
    : (signups === 1 ? 'signup' : 'signups')
  const hasCap = Number.isFinite(capacity) && capacity > 0
  if (hasCap && mode === 'people') {
    return `${people} / ${capacity} ${peopleNoun} · ${signups} ${unit}`
  }
  const cap = hasCap ? ` / ${capacity}` : ''
  return `${people} ${peopleNoun} · ${signups}${cap} ${unit}`
}

// Capacity-mode helpers. An event caps either by team/registration count
// ('teams', the historical default) or by headcount ('people'). The number
// itself lives per-wave on race_waves.capacity; the mode (race_events.
// capacity_mode) decides what that number means. These power the signup
// gate, the public "wave full" check, the agent, and the list display.

/**
 * A wave's current load under a capacity mode. Confirmed-only.
 * @param {Array} registrations
 * @param {'teams'|'people'} [mode]
 * @returns {number}
 */
export function loadForMode(registrations, mode) {
  const { people, signups } = computeSignupCounts(registrations)
  return mode === 'people' ? people : signups
}

/**
 * Spots remaining in a wave, or null when uncapped. Never negative.
 * @param {number|null} capacity
 * @param {Array} registrations
 * @param {'teams'|'people'} [mode]
 * @returns {number|null}
 */
export function spotsLeft(capacity, registrations, mode) {
  if (!Number.isFinite(capacity)) return null
  return Math.max(0, capacity - loadForMode(registrations, mode))
}

/**
 * Would an incoming registration of `incomingTeamSize` people fit in the
 * wave? In teams mode a registration adds one regardless of size; in people
 * mode the whole group must fit. Uncapped waves always fit.
 * @param {number|null} capacity
 * @param {Array} registrations  existing confirmed registrations in the wave
 * @param {'teams'|'people'} mode
 * @param {number} [incomingTeamSize]
 * @returns {boolean}
 */
export function wouldFit(capacity, registrations, mode, incomingTeamSize = 1) {
  if (!Number.isFinite(capacity)) return true
  const increment = mode === 'people'
    ? (Number.isFinite(incomingTeamSize) && incomingTeamSize > 0 ? incomingTeamSize : 1)
    : 1
  return loadForMode(registrations, mode) + increment <= capacity
}

/**
 * Total capacity across an event's waves, or null (unlimited) when there
 * are no waves or ANY wave is uncapped.
 * @param {Array<{capacity?:number|null}>|null} waves
 * @returns {number|null}
 */
export function sumWaveCapacity(waves) {
  if (!Array.isArray(waves) || waves.length === 0) return null
  let total = 0
  for (const w of waves) {
    const cap = w?.capacity
    if (!Number.isFinite(cap)) return null
    total += cap
  }
  return total
}
