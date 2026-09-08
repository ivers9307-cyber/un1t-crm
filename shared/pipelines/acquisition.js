// PIPELINES.2 — the Glofox acquisition board, as a board module.
//
// This is a WRAPPER, not a rewrite. classify() delegates to the existing
// classifyContact() so this change can be proven to move nobody: the gate is a
// dry-run reclassify at Stillorgan reporting deals_moved: 0 across 8,602 deals.
// Its rules, thresholds and war-story comments stay in
// shared/pipeline-classifier.js.
//
// requiredFields is the one genuinely new thing. It replaces the
// hand-maintained SELECT_COLS list in pipeline-reclassify.js, which carried
// five separate comments warning that omitting a field makes the nightly cron
// classify on nulls and flap webhook-placed deals. The orchestrator now unions
// what each board DECLARES rather than what a human remembered to add.

import { classifyContact } from '../pipeline-classifier.js'

// Mirrors the live prod rows (migs 350/356/391/430). Order 301+ sorts after
// the archived PIPELINE5 200-block.
export const stages = Object.freeze([
  { slug: 'new_lead',     name: 'New Leads',  display_order: 301, color: '#3B82F6', is_dormant: false },
  { slug: 'first_class',  name: '1st Class',  display_order: 302, color: '#10B981', is_dormant: false },
  { slug: 'second_class', name: '2nd Class',  display_order: 303, color: '#14B8A6', is_dormant: false },
  { slug: 'trial_done',   name: 'Trial Done', display_order: 304, color: '#F59E0B', is_dormant: false },
  { slug: 'converted',    name: 'Converted',  display_order: 305, color: '#059669', is_dormant: false },
  { slug: 'member',       name: 'Member',     display_order: 306, color: '#64748B', is_dormant: true },
  { slug: 'pack_member',  name: 'Class Pack', display_order: 307, color: '#0891B2', is_dormant: true },
  { slug: 'classpass',    name: 'ClassPass',  display_order: 308, color: '#A855F7', is_dormant: true },
  { slug: 'dormant',      name: 'Dormant',    display_order: 309, color: '#6B7280', is_dormant: true },
  { slug: 'cold_lead',    name: 'Cold',       display_order: 310, color: '#52525B', is_dormant: true },
  { slug: 'gympass',      name: 'Gympass',    display_order: 311, color: '#F97316', is_dormant: true },
])

// Every contacts column classifyContact() reads. Keep in lockstep with it —
// shared/pipelines/index.test.js pins the ones that flap if dropped.
export const requiredFields = Object.freeze([
  'id',
  'name',
  'email',
  'glofox_membership_status',
  'glofox_membership_state',
  'glofox_membership_expiry',
  'last_attended_at',
  'total_attended_7d',
  'total_attended_30d',
  'last_payment_at',
  'joined_at',
  'created_at',
  'trial_credits_remaining',
  'recent_bookings',
  'converted_at',
  'pack_customer_at',
  'pipeline_dismissed_at',
  'gympass_member_id',
  'last_lead_source_at',
])

// The acquisition board never abstains: classifyContact() always returns a
// slug and 'dormant' is its fallthrough. Kept explicit so the contract is
// visible — a board that CAN abstain returns null and the orchestrator closes
// the deal.
export function classify(contact, now = Date.now()) {
  return classifyContact(contact, now)
}
