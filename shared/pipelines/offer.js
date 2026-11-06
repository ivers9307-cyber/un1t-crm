// PIPEBUILD.3a — the offer board module. One module serves every self-service
// offer board: its stages and day counts come from the board's parsed config
// (./offer-config.js), not from this file. Like paid-trial it only sees a
// contact the router sent it with a live claim { start, end, source }.
// Every instant is epoch ms; no wall-clock date parsing. Pure, no IO.

import {
  DAY_MS, attendedSince, convertedSince, lastActivityMs,
  requiredFields as paidTrialFields,
} from './paid-trial.js'

export const requiredFields = Object.freeze([
  ...paidTrialFields,
  'lead_source',
  'last_lead_source',
  'last_lead_source_at',
  'glofox_membership_plan',
].filter((f, i, a) => a.indexOf(f) === i))

// Stages come from config, so the registry's static list is empty.
export const stages = Object.freeze([])

const COLORS = Object.freeze({
  new: '#3B82F6',
  first_class: '#10B981',
  class_n: '#14B8A6',
  checkpoint: '#8B5CF6',
  done: '#F59E0B',
  converted: '#059669',
})

/** Board rows for a parsed config, in the order given, from display_order 900. */
export function stagesFor(config) {
  return config.stages.map((s, i) => ({
    slug: s.slug,
    name: s.name,
    stage_role: s.role,
    role_config: s.role === 'class_n' ? { count: s.count } : s.role === 'checkpoint' ? { day: s.day } : {},
    display_order: 900 + i,
    color: COLORS[s.role],
    is_dormant: false,
  }))
}

const msOf = (iso) => {
  if (iso == null) return null
  const ms = typeof iso === 'number' ? iso : Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** paid-trial's claimLive rule with the board's own quiet and converted windows. */
export function offerClaimLive(claim, contact, now, config) {
  if (!claim) return false
  const activity = lastActivityMs(contact)
  if (convertedSince(contact, claim.end)) {
    const convertedMs = msOf(contact?.converted_at)
    const since = convertedMs != null ? Math.max(convertedMs, claim.start) : Math.max(claim.start, activity ?? claim.start)
    return now - since < config.converted_window_days * DAY_MS
  }
  const quietFrom = Math.max(claim.end, activity ?? 0)
  return now - quietFrom < config.quiet_days * DAY_MS
}

/**
 * The column slug for a contact with a live claim. A role the config lacks
 * falls through to the next earlier role present, never past `new`.
 */
export function classify(contact, now, claim, config) {
  if (!claim) throw new TypeError('offer classify needs a live claim')
  const byRole = (role) => config.stages.filter((s) => s.role === role)
  const one = (role) => byRole(role)[0]?.slug
  const attended = attendedSince(contact, claim.start)

  if (convertedSince(contact, claim.end) && one('converted')) return one('converted')
  if (now >= claim.end && one('done')) return one('done')

  const passed = byRole('checkpoint').filter((s) => now >= claim.start + s.day * DAY_MS)
  if (passed.length) return passed.reduce((a, b) => (b.day > a.day ? b : a)).slug

  const reached = byRole('class_n').filter((s) => s.count <= attended)
  if (reached.length) return reached.reduce((a, b) => (b.count > a.count ? b : a)).slug

  if (attended >= 1 && one('first_class')) return one('first_class')
  return one('new')
}
