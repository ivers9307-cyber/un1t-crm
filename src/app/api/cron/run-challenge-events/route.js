// Vercel cron — daily 08:00 UTC. Announces challenge start / end-winner /
// collective-target via push to app-linked members at the location. Idempotent
// via the challenges.announced_* columns. Mirrors notify-streak-at-risk.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendCustomerPush } from '@/lib/customer-push'
import { computeStandings, computeCollective } from '@/lib/challenges-io'
import { windowIso } from '@/lib/challenges'
import { buildChallengeStartPush, buildChallengeResultPush, buildCollectiveTargetPush } from '@/lib/challenge-notifications'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

async function tokenHolders(db, locationId) {
  const { data } = await db
    .from('champ_push_tokens')
    .select('contact_id, contacts!inner(location_id)')
    .eq('contacts.location_id', locationId)
  return [...new Set((data || []).map((r) => r.contact_id).filter(Boolean))]
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

  const { data: challenges } = await db.from('challenges').select('*')
  let started = 0, ended = 0, targets = 0
  for (const ch of challenges || []) {
    try {
      // START
      if (ch.starts_on === today && !ch.announced_start_at) {
        const ids = await tokenHolders(db, ch.location_id)
        if (ids.length) await sendCustomerPush(db, ids, buildChallengeStartPush(ch))
        await db.from('challenges').update({ announced_start_at: stamp }).eq('id', ch.id)
        started++
      }
      // END + winner/result
      if (ch.ends_on < today && !ch.announced_end_at) {
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
        if (ids.length) await sendCustomerPush(db, ids, payload)
        await db.from('challenges').update({ announced_end_at: stamp }).eq('id', ch.id)
        ended++
      }
      // COLLECTIVE target reached (active, not yet announced)
      if (ch.mode === 'collective' && ch.target && !ch.announced_target_at && ch.starts_on <= today && ch.ends_on >= today) {
        const { fromIso, toIso } = windowIso(ch)
        const collective = await computeCollective(db, { locationId: ch.location_id, metric: ch.metric, fromIso, toIso, target: ch.target })
        if (collective.total >= ch.target) {
          const ids = await tokenHolders(db, ch.location_id)
          if (ids.length) await sendCustomerPush(db, ids, buildCollectiveTargetPush(ch))
          await db.from('challenges').update({ announced_target_at: stamp }).eq('id', ch.id)
          targets++
        }
      }
    } catch (err) {
      logWarn('cron-challenge-events', 'per-challenge failed', { err, id: ch.id })
    }
  }
  logInfo('cron-challenge-events', 'tick', { started, ended, targets })
  await stampHeartbeat('run-challenge-events').catch((err) => logWarn('cron-challenge-events', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, started, ended, targets })
}
