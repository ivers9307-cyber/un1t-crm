// PIPE3.2 — the Programmes board (UN1T Stillorgan): 50+ and pre/post natal
// leads, who get ONE free class. Richard's columns, 31 Oct 2026: Lead, 1st
// Class Done, Converted.
// Spec: docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md
//
// Who is a programme lead is a SETTING on the studio
// (locations.settings.pipelines.programmes: lead_sources, glofox_plan_patterns),
// so /postnatal plugs in without a deploy. The match is made ONCE and
// recorded as a claim (pipeline_board_claims, mig 797): Glofox overwrites the
// plan name on every sync, so a lead who joins stops matching at the exact
// moment they should enter Converted. This module only ever sees a contact the
// router sent it, with that recorded claim.
//
// Pure, no IO. Every instant is epoch ms.

import {
  attendedSince, convertedSince, lastActivityMs, QUIET_DAYS, CONVERTED_WINDOW_DAYS, DAY_MS,
} from './paid-trial.js'
import { requiredFields as paidTrialFields } from './paid-trial.js'

// Mirrors mig 797. Order 701+ sorts after the €39 board's 600-block.
export const stages = Object.freeze([
  { slug: 'programme_lead',        name: 'Lead',           display_order: 701, color: '#3B82F6', is_dormant: false },
  { slug: 'programme_first_class', name: '1st Class Done', display_order: 702, color: '#10B981', is_dormant: false },
  { slug: 'programme_converted',   name: 'Converted',      display_order: 703, color: '#059669', is_dormant: false },
])

// The acquisition set (the router runs classifyContact on the same row) plus
// the three columns the entry match reads.
export const requiredFields = Object.freeze([
  ...paidTrialFields,
  'lead_source',
  'last_lead_source',
  'glofox_membership_plan',
])

const parseMs = (iso) => {
  if (iso == null) return null
  const ms = typeof iso === 'number' ? iso : Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}
const lower = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '')
const list = (v) => (Array.isArray(v) ? v.map(lower).filter(Boolean) : [])

/**
 * Does this contact's row carry a programme signal under these rules?
 * A lead-source match (dated at last_lead_source_at, else now) outranks a
 * Glofox plan-name match (dated now: the plan carries no start date).
 *
 * @param {object|null} contact
 * @param {{ lead_sources?: string[], glofox_plan_patterns?: string[] }|null} rules
 * @param {number} now  epoch ms
 * @returns {{ claimedAt: number, source: 'lead_source'|'glofox_plan' }|null}
 */
export function matchProgrammeSignal(contact, rules, now = Date.now()) {
  if (!contact || typeof contact !== 'object' || !rules) return null
  const sources = list(rules.lead_sources)
  const patterns = list(rules.glofox_plan_patterns)

  // last_lead_source is the latest touch; lead_source only speaks when there is
  // no latest touch at all (a row stamped before mig 557).
  const touch = lower(contact.last_lead_source) || (contact.last_lead_source == null ? lower(contact.lead_source) : '')
  if (touch && sources.includes(touch)) {
    return { claimedAt: parseMs(contact.last_lead_source_at) ?? now, source: 'lead_source' }
  }

  const plan = lower(contact.glofox_membership_plan)
  if (plan && patterns.some((p) => plan.includes(p))) {
    return { claimedAt: now, source: 'glofox_plan' }
  }
  return null
}

/**
 * Is the recorded claim still this person's board? Converted: 60 days from
 * converted_at (or the last activity when the stamp is missing). Otherwise 60
 * quiet days from the later of the claim and their last class or payment.
 * @param {{ claimedAt: number }|null} claim
 */
export function programmeClaimLive(claim, contact, now = Date.now()) {
  if (!claim || !Number.isFinite(claim.claimedAt)) return false
  const activity = lastActivityMs(contact)
  if (convertedSince(contact, claim.claimedAt)) {
    const since = parseMs(contact?.converted_at) ?? Math.max(claim.claimedAt, activity ?? claim.claimedAt)
    return now - since < CONVERTED_WINDOW_DAYS * DAY_MS
  }
  const quietFrom = Math.max(claim.claimedAt, activity ?? 0)
  return now - quietFrom < QUIET_DAYS * DAY_MS
}

/**
 * The Programmes board's column for a contact with a live claim.
 * @returns {string} stage slug
 */
export function classify(contact, now = Date.now(), claim = null) {
  if (!claim || !Number.isFinite(claim.claimedAt)) throw new TypeError('programmes classify needs a live claim')
  if (convertedSince(contact, claim.claimedAt)) return 'programme_converted'
  if (attendedSince(contact, claim.claimedAt) >= 1) return 'programme_first_class'
  return 'programme_lead'
}
