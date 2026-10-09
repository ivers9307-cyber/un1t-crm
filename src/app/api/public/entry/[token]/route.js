// GET /api/public/entry/[token] — EVENT-MOVE.6
//
// Public, no session. The entry behind a signed entry-manage token (the
// "Change your date" link in the confirmation and moved emails), for the
// /event/entry/[token] page. The token is the only credential: a bad,
// expired or forged one, or an entry that no longer exists, is a 404.
//
// Same public shape as /api/public/event-registrations/[id] (team name,
// size, wave, member names, roles, member flag, the check-in QR for a
// confirmed entry; never an email or a phone) plus:
//   can_move             the holder may change the date now
//   move_blocked_reason  a plain sentence when they may not (unpaid,
//                        cancelled, checked in, past)
//   date_change_pending  a dearer date change is waiting on its payment
//
// A paid date change returns the buyer HERE, often before the payment
// webhook: the newest pending date-change payment is refreshed from the
// provider first (as /api/public/event-payments/[id] does), which completes
// it and makes the move, so the page shows the new date.
//
// Rate limited per IP: 60 per 5 minutes (bucket shared with move-options).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { verifyEntryManageTokenFromEnv } from '@/lib/entry-manage-tokens'
import { signCheckinToken } from '@/lib/event-checkin-tokens'
import { countEntryCheckins } from '@/lib/registration-move'
import { entryMoveBlock, customerMoveMessage } from '@/lib/registration-move-public'
import { refreshRacePaymentFromProvider } from '@/lib/race-payments'
import { GAP_PAYMENT_KIND } from '@/lib/registration-entry'
import { dublinTodayStr } from '@/lib/dublin-time'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (code, status) => NextResponse.json({ success: false, error: code, message: customerMoveMessage(code) }, { status })

/**
 * The newest customer date-change payment still pending on this entry,
 * refreshed from the provider. true when one is still pending afterwards.
 * Best-effort: a failure here never costs the page.
 */
async function settlePendingDateChange(db, registrationId) {
  try {
    const { data: rows, error } = await db
      .from('race_payments')
      .select('id, kind, status, payment_provider, payment_provider_ref')
      .eq('race_registration_id', registrationId)
      .eq('kind', GAP_PAYMENT_KIND)
      .eq('status', 'pending')
      .is('registration_move_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
    if (error) {
      logWarn('public-entry', 'pending date-change read failed; page shows the entry as stored', { err: error, registrationId })
      return false
    }
    const pending = Array.isArray(rows) ? rows[0] : null
    if (!pending) return false
    const live = await refreshRacePaymentFromProvider(db, pending)
    return (live?.status || pending.status) === 'pending'
  } catch (e) {
    logWarn('public-entry', 'pending date-change refresh threw; page shows the entry as stored', { err: e, registrationId })
    return false
  }
}

export async function GET(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `entry:${getClientIp(request)}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const claim = verifyEntryManageTokenFromEnv(token)
  if (!claim) return fail('not_found', 404)

  const dateChangePending = await settlePendingDateChange(db, claim.registrationId)

  const { data, error } = await db
    .from('race_registrations')
    .select(`
      id, status, registered_at, team_composition, race_started_at, race_finished_at,
      race:race_event_id (
        id, name, slug, kind, race_date, location_id,
        locations:location_id ( name, address )
      ),
      wave:wave_id ( id, start_time, label ),
      teams:team_id ( id, name, size,
        team_members ( id, name, role, is_member ) )
    `)
    .eq('id', claim.registrationId)
    .maybeSingle()
  if (error) return fail('load_failed', 500)
  if (!data) return fail('not_found', 404)

  const checkins = await countEntryCheckins(db, data.id)
  const block = checkins.error
    ? { code: 'load_failed', message: customerMoveMessage('load_failed') }
    : entryMoveBlock({ registration: data, checkinCount: checkins.count, today: dublinTodayStr() })

  // The check-in QR, exactly as /api/public/event-registrations/[id] mints it
  // (same exposure as the email the holder already has; confirmed only).
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || null
  const eventId = data.race?.id || null
  const canMintQr = data.status === 'confirmed' && !!secret && !!eventId
  const members = (data.teams?.team_members || []).map((m) => {
    const base = { id: m.id, name: m.name, role: m.role, is_member: m.is_member }
    if (!canMintQr || !m?.id) return base
    const t = signCheckinToken({ eventId, registrationId: data.id, memberId: m.id }, secret)
    return { ...base, qr_url: `/api/public/events/checkin-qr?t=${encodeURIComponent(t)}` }
  })

  return NextResponse.json({
    success: true,
    data: {
      id: data.id,
      status: data.status,
      registered_at: data.registered_at,
      team_composition: data.team_composition,
      race: data.race,
      wave: data.wave,
      team: data.teams ? { id: data.teams.id, name: data.teams.name, size: data.teams.size, team_members: members } : null,
      can_move: !block,
      move_blocked_reason: block ? block.message : null,
      date_change_pending: dateChangePending,
    },
  })
}
