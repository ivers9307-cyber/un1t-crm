// Vercel cron — daily 08:00 UTC. Announces challenge start / end-winner /
// collective-target via push to app-linked members at the location. Idempotent
// via the challenges.announced_* columns. Mirrors notify-streak-at-risk.
//
// C21 PUSHDONE.1b — each announcement is now CLAIMED before the send (a CAS
// UPDATE of its announced_* column from null) and the claim is RELEASED when
// the push reached nobody because something broke (pushOutcome 'failed').
// It used to stamp after the send whatever happened, with the error of that
// stamp discarded: a failed broadcast was recorded as announced (lost), and a
// lost stamp after a good broadcast re-announced to EVERY member the next day.
// For a location-wide member broadcast the duplicate is the worse failure, so
// the claim goes first; the price is that a process killed between claim and
// send loses the announcement (logged nowhere, as on main). A released END or
// TARGET is re-tried by the next daily run (its predicate still matches); a
// released START is re-tried only by a same-day re-run, because START fires
// on `starts_on === today` (widening that is a customer-facing change: see
// the plan's open question).
//
// The END retry is BOUNDED: `ends_on < today` stays true for ever, so a
// persistent push failure used to be re-tried daily and could reach members
// weeks after the challenge ended. END goes out only while ends_on is within
// END_ANNOUNCE_RETRY_DAYS of today (Europe/Dublin dates); past that it is
// stamped WITHOUT a send and said with a logError (mirrors 1a's bounded
// retries). Nothing is sent without a claim either way.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendCustomerPush } from '@/lib/customer-push'
import { pushOutcome } from '@/lib/push-outcome'
import { computeStandings, computeCollective } from '@/lib/challenges-io'
import { windowIso } from '@/lib/challenges'
import { buildChallengeStartPush, buildChallengeResultPush, buildCollectiveTargetPush } from '@/lib/challenge-notifications'
import { logInfo, logWarn, logError } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { selectAll } from '@/lib/select-all'
import { dublinDayStr, dublinAddDays } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MODULE = 'cron-challenge-events'

/** A released END announcement is retried while ends_on >= (Dublin today - this); later it is given up. */
export const END_ANNOUNCE_RETRY_DAYS = 2

/**
 * Claim one announcement (CAS on its announced_* column), send it, and give
 * the claim back if nothing reached anyone because something broke. `ids` and
 * `payload` are worked out BEFORE the claim, so a throw there claims nothing.
 * Never throws.
 * @returns {Promise<'delivered'|'settled'|'already'|'claim_failed'|'released'|'release_failed'>}
 */
async function announceOnce(db, ch, column, stamp, ids, payload) {
  const { data: claimed, error: claimErr } = await db.from('challenges')
    .update({ [column]: stamp })
    .eq('id', ch.id)
    .is(column, null)
    .select('id')
  if (claimErr) {
    logWarn(MODULE, 'announcement claim failed; nothing sent, the next run retries', { id: ch.id, column, err: claimErr.message })
    return 'claim_failed'
  }
  if (!claimed?.length) return 'already'
  if (!ids.length) return 'settled'

  let result = null
  try {
    result = await sendCustomerPush(db, ids, payload)
  } catch (err) {
    logWarn(MODULE, 'announcement push threw', { id: ch.id, column, err: err?.message || String(err) })
  }
  const outcome = pushOutcome(result)
  if (outcome !== 'failed') return outcome

  const { error: releaseErr } = await db.from('challenges')
    .update({ [column]: null })
    .eq('id', ch.id)
    .eq(column, stamp)
  if (releaseErr) {
    logError(MODULE, 'announcement reached nobody and the claim release failed; it will not be sent', { id: ch.id, column, err: releaseErr.message })
    return 'release_failed'
  }
  logWarn(MODULE, 'announcement reached nobody; claim released, the next run retries', { id: ch.id, column, read_failed: !!result?.read_failed })
  return 'released'
}

/**
 * Past its retry window: stamp announced_end_at (CAS on null) WITHOUT a send,
 * so a late result never reaches members, and say so at error level.
 * @returns {Promise<'gave_up'|'already'|'claim_failed'>}
 */
async function giveUpEnd(db, ch, stamp) {
  const { data, error } = await db.from('challenges')
    .update({ announced_end_at: stamp })
    .eq('id', ch.id)
    .is('announced_end_at', null)
    .select('id')
  if (error) {
    logWarn(MODULE, 'end announcement is past its retry window and the give-up stamp failed; the next run tries again', { challengeId: ch.id, err: error.message })
    return 'claim_failed'
  }
  if (!data?.length) return 'already'
  logError(MODULE, 'end announcement not sent within its retry window; gave up', { challengeId: ch.id })
  return 'gave_up'
}

const ANNOUNCED = new Set(['delivered', 'settled'])
const FAILED = new Set(['claim_failed', 'released', 'release_failed'])

async function tokenHolders(db, locationId) {
  // AUDIT P1-2 — paginated. A large location can have >1000 app-linked push
  // tokens; an un-paginated select would silently miss everyone past row 1000,
  // so they'd never receive challenge-start/result pushes. A throw propagates
  // to the per-challenge try/catch in the caller (best-effort).
  const data = await selectAll((from, to) => db
    .from('champ_push_tokens')
    .select('contact_id, contacts!inner(location_id)')
    .eq('contacts.location_id', locationId)
    .order('contact_id', { ascending: true })
    .range(from, to))
  return [...new Set(data.map((r) => r.contact_id).filter(Boolean))]
}

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const nowMs = Date.now()
  const stamp = new Date(nowMs).toISOString()
  const today = stamp.slice(0, 10)
  const endRetryFloor = dublinAddDays(dublinDayStr(nowMs), -END_ANNOUNCE_RETRY_DAYS)

  // Only challenges that still need an event: start or end not yet announced.
  // (Active-collective target checks need end-null, so they're covered.)
  // AUDIT P1-2 — paginated across all locations; the un-announced set grows
  // unbounded as locations onboard, and a 1000-row cap would silently stop
  // announcing once it's exceeded. Keep best-effort so a fetch error doesn't
  // skip the heartbeat stamp at the end of the tick.
  const challenges = await selectAll((from, to) => db
    .from('challenges')
    .select('*')
    .or('announced_start_at.is.null,announced_end_at.is.null')
    .order('id', { ascending: true })
    .range(from, to)).catch(() => [])
  let started = 0, ended = 0, targets = 0, failed = 0, gaveUp = 0
  const count = (outcome, bump) => {
    if (ANNOUNCED.has(outcome)) bump()
    else if (FAILED.has(outcome)) failed++
  }
  for (const ch of challenges || []) {
    try {
      // START
      if (ch.starts_on === today && !ch.announced_start_at) {
        const ids = await tokenHolders(db, ch.location_id)
        count(await announceOnce(db, ch, 'announced_start_at', stamp, ids, buildChallengeStartPush(ch)), () => started++)
      }
      // END + winner/result
      if (ch.ends_on < today && !ch.announced_end_at && ch.ends_on < endRetryFloor) {
        const outcome = await giveUpEnd(db, ch, stamp)
        if (outcome === 'gave_up') gaveUp++
        else if (FAILED.has(outcome)) failed++
      } else if (ch.ends_on < today && !ch.announced_end_at) {
        const { fromIso, toIso } = windowIso(ch)
        let payload
        if (ch.mode === 'collective') {
          const collective = await computeCollective(db, { locationId: ch.location_id, metric: ch.metric, fromIso, toIso, target: ch.target })
          payload = buildChallengeResultPush({ challenge: ch, collective })
        } else {
          const standings = await computeStandings(db, { locationId: ch.location_id, metric: ch.metric, fromIso, toIso })
          payload = buildChallengeResultPush({ challenge: ch, winner: standings[0] || null })
        }
        const ids = await tokenHolders(db, ch.location_id)
        count(await announceOnce(db, ch, 'announced_end_at', stamp, ids, payload), () => ended++)
      }
      // COLLECTIVE target reached (active, not yet announced)
      if (ch.mode === 'collective' && ch.target && !ch.announced_target_at && ch.starts_on <= today && ch.ends_on >= today) {
        const { fromIso, toIso } = windowIso(ch)
        const collective = await computeCollective(db, { locationId: ch.location_id, metric: ch.metric, fromIso, toIso, target: ch.target })
        if (collective.total >= ch.target) {
          const ids = await tokenHolders(db, ch.location_id)
          count(await announceOnce(db, ch, 'announced_target_at', stamp, ids, buildCollectiveTargetPush(ch)), () => targets++)
        }
      }
    } catch (err) {
      logWarn('cron-challenge-events', 'per-challenge failed', { err, id: ch.id })
    }
  }
  logInfo(MODULE, 'tick', { started, ended, targets, failed, gave_up: gaveUp })
  await stampHeartbeat('run-challenge-events').catch((err) => logWarn('cron-challenge-events', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, started, ended, targets, failed, gave_up: gaveUp })
}
