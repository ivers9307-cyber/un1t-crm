// C21 PUSHDONE.1b — the one claim-before-send path for member (champ-app)
// engagement pushes: streak-at-risk, winback, onboarding pace, class
// reminders, goal-complete and tier-up.
//
// Every caller used to hand-roll it: insert a customer_engagement_nudges row
// (the unique (contact_id, type, dedup_key) index is the at-most-once guard),
// then send, then IGNORE the result — so a push that reached nobody (Expo
// down, a failed token read) kept its claim and the nudge was gone for good.
// Only the class-reminder cron released on failure.
//
// Why claim FIRST for members (the staff side stamps AFTER): a duplicate
// "you're about to lose your streak" to a member is worse than a missed one,
// so the at-most-once claim stays in front of the send. A claim is released
// only when nothing reached the member AND something broke (pushOutcome
// 'failed'), which cannot duplicate anything. The residual risk is a process
// killed between claim and send (the nudge is lost, as on main) — accepted for
// engagement pushes, and said here so nobody mistakes it for a lease.
//
// Nothing is sent without a claim: a failed claim INSERT (anything but the
// unique violation) is logged and skipped, and a later run tries again.

import { sendCustomerPush } from './customer-push'
import { pushOutcome } from './push-outcome'
import { logWarn, logError } from './log'

const UNIQUE_VIOLATION = '23505'
const CHUNK = 200

/**
 * Which of `contactIds` have a registered champ push token. A failed read is
 * not "unreachable": that chunk is skipped this run, counted in `failed`, and
 * logged — nobody in it is claimed, so the next run tries them again.
 *
 * @returns {Promise<{ reachable: Set<string>, failed: number }>}
 */
export async function readReachableContacts(db, contactIds, module) {
  const reachable = new Set()
  let failed = 0
  const ids = [...new Set((contactIds || []).filter(Boolean))]
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    const { data, error } = await db.from('champ_push_tokens').select('contact_id').in('contact_id', chunk)
    if (error) {
      failed += chunk.length
      logWarn(module, 'push-token read failed; these members are skipped this run and retried by the next', {
        contacts: chunk.length, err: error.message,
      })
      continue
    }
    for (const t of data || []) reachable.add(t.contact_id)
  }
  return { reachable, failed }
}

/**
 * Claim (contact, type, dedupKey), send, and release the claim when nothing
 * reached the member because something broke. Never throws.
 *
 * @returns {Promise<{ status: 'sent'|'settled'|'deduped'|'claim_failed'|'released'|'release_failed', result: object|null }>}
 *   sent — delivered; settled — nothing to deliver to (kept, not retried);
 *   deduped — already claimed; claim_failed — nothing sent, retried later;
 *   released — failed, claim freed so a later run retries;
 *   release_failed — failed AND the claim could not be freed (logError: lost).
 */
export async function sendNudgeOnce(db, { contactId, type, dedupKey, payload, module }) {
  const meta = { contactId, type, dedupKey }
  const { data, error } = await db
    .from('customer_engagement_nudges')
    .insert({ contact_id: contactId, type, dedup_key: dedupKey })
    .select('id')
  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { status: 'deduped', result: null }
    logWarn(module, 'nudge claim failed; nothing sent, a later run retries', { ...meta, err: error.message })
    return { status: 'claim_failed', result: null }
  }
  const claimId = data?.[0]?.id
  if (!claimId) {
    // No error and no row should not happen (the insert selects its id). Treat
    // it as claimed elsewhere, so nothing is sent unclaimed, but say it.
    logWarn(module, 'nudge claim insert returned no row; treated as already claimed, nothing sent', meta)
    return { status: 'deduped', result: null }
  }

  let result = null
  try {
    result = await sendCustomerPush(db, contactId, payload)
  } catch (err) {
    logWarn(module, 'push threw', { ...meta, err: err?.message || String(err) })
  }
  const outcome = pushOutcome(result)
  if (outcome === 'delivered') return { status: 'sent', result }
  if (outcome === 'settled') return { status: 'settled', result }

  const { error: releaseErr } = await db.from('customer_engagement_nudges').delete().eq('id', claimId)
  if (releaseErr) {
    logError(module, 'nothing delivered and the claim release failed; this nudge will not retry', { ...meta, err: releaseErr.message })
    return { status: 'release_failed', result }
  }
  logWarn(module, 'nothing delivered; claim released, a later run retries', { ...meta, read_failed: !!result?.read_failed })
  return { status: 'released', result }
}

/** A sendNudgeOnce status that means "this member did not get it this run". */
export function nudgeFailed(status) {
  return status === 'claim_failed' || status === 'released' || status === 'release_failed'
}
