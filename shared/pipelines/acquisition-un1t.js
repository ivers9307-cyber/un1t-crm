// HATCHPIPE.2 — the acquisition board, fed from un1t.online instead of contacts.
//
// Same stages as the Glofox acquisition board, by reference. inputSource tells
// the pipeline reclassifier to read this board's inputs from un1t.online
// (un1t_* mirror tables) rather than the contacts columns, so requiredFields
// is the identity set the reclassifier needs to place and report a row, not the
// contacts column list acquisition.js carries.
//
// TRIALDONE.2 — classify() is classifyContact() with ONE un1t-only rule on top:
// exactly 2 attended (classifyContact's 'second_class') AND the trial has
// expired (snapshot.trial_expires_at, the newest trial grant + that trial
// product's expire_credits_in_days, shapePipelineSnapshot) is 'trial_done'.
// A person cannot attend a third trial class once the trial has run out, so
// two is as far as the trial goes. classifyContact itself is not changed:
// Stillorgan's Glofox board (acquisition.js) never sees this rule.
//
// A board that does not declare inputSource reads contacts (acquisition.js).

import { classifyContact } from '../pipeline-classifier.js'

export { stages } from './acquisition.js'

export const inputSource = 'un1t_online'

export const requiredFields = Object.freeze(['id', 'name', 'email', 'location_id'])

/**
 * The un1t board's stage for one snapshot (shapePipelineSnapshot).
 * An unknown or unreadable trial_expires_at is never "expired".
 *
 * @param {object} snapshot
 * @param {number} [now]  epoch ms
 * @returns {string} stage slug
 */
export function classify(snapshot, now = Date.now()) {
  const slug = classifyContact(snapshot, now)
  if (slug !== 'second_class') return slug
  const expiresMs = snapshot?.trial_expires_at ? Date.parse(snapshot.trial_expires_at) : NaN
  return Number.isFinite(expiresMs) && expiresMs <= now ? 'trial_done' : slug
}
