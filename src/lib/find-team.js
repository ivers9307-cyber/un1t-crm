// FINDTEAM.2 — "Find me a team": settings, copy defaults and the capacity rule.
// A solo entrant registers as a team of one flagged looking_for_team; staff place
// them into a team later. No IO, no React/Next/Supabase.

import { z } from 'zod'

export const FIND_TEAM_DEFAULTS = Object.freeze({
  enabled: false,
  label: 'Find me a team',
  blurb:
    "No team? No problem. Book your place and we'll put you with a team in your wave. We'll email you once you're placed.",
  confirmation_paragraph:
    "You booked a solo place. We'll put you with a team in your wave and email you once you're placed.",
  placed_subject: "You're on a team for {{event_name}}",
  placed_intro: "Good news, {{first_name}}: you've been placed with team {{team_name}} in the {{when}} wave.",
})

const copy = z.string().trim().max(2000)

/** Validates what an operator saves into race_events.find_team. Every key optional. */
export const FindTeamSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  label: copy.optional(),
  blurb: copy.optional(),
  confirmation_paragraph: copy.optional(),
  placed_subject: copy.optional(),
  placed_intro: copy.optional(),
})

/**
 * A race_events row's find-team settings with defaults filled in. Keys saved as
 * null/undefined fall back; an empty string is kept (cleared on purpose).
 * `enabled` always resolves to a boolean.
 * @param {{ find_team?: object|null }|null|undefined} race
 * @returns {typeof FIND_TEAM_DEFAULTS}
 */
export function resolveFindTeamSettings(race) {
  const saved = race?.find_team && typeof race.find_team === 'object' && !Array.isArray(race.find_team) ? race.find_team : {}
  const out = { ...FIND_TEAM_DEFAULTS }
  for (const [k, v] of Object.entries(saved)) {
    if (v !== null && v !== undefined) out[k] = v
  }
  out.enabled = out.enabled === true
  return out
}

/**
 * The team name given to a solo entrant until staff place them.
 * @param {string} fullName
 * @returns {string}
 */
export function soloTeamName(fullName) {
  return `${String(fullName ?? '').trim()} (looking for a team)`
}

/**
 * Does this registration use up a team slot in a `teams`-capacity wave? A solo
 * still looking for a team is a person, not a team, so it does not; once placed
 * (status 'placed') it joins an existing team's slot.
 * @param {{ status?: string, looking_for_team?: boolean }|null|undefined} reg
 * @returns {boolean}
 */
export function countsTowardTeamCapacity(reg) {
  return reg?.status === 'confirmed' && !reg?.looking_for_team
}
