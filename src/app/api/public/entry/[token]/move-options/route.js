// GET /api/public/entry/[token]/move-options — EVENT-MOVE.6
//
// Public, no session; the signed entry token is the credential (404 on any
// bad one). The dates and times the token holder may move their entry to:
// listMoveTargets (same payee, published, upcoming, the entry's organisation, the entry's
// size accepted) reduced by publicMoveOptions to times with room, with a
// price difference and a sentence for it. NEVER capacity, places left or
// any count: that is staff data (spec, "listMoveTargets ... this endpoint is
// never public"; this route is the public reduction of it).
//
// { can_move, move_blocked_reason, options }. A blocked entry (unpaid,
// cancelled, checked in, past) answers can_move false, its reason and no
// options. Shares the summary's rate limit bucket: 60 per 5 minutes per IP.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { verifyEntryManageTokenFromEnv } from '@/lib/entry-manage-tokens'
import { readRegistrationForMove, countEntryCheckins, listMoveTargets, moveLocationIds } from '@/lib/registration-move'
import { entryMoveBlock, publicMoveOptions, customerMoveMessage, CUSTOMER_MOVE_STATUS } from '@/lib/registration-move-public'
import { dublinTodayStr } from '@/lib/dublin-time'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const fail = (code) => NextResponse.json(
  { success: false, error: code, message: customerMoveMessage(code) },
  { status: CUSTOMER_MOVE_STATUS[code] || 400 },
)

export async function GET(request, props) {
  const { token } = await props.params
  const db = createServerClient()

  const limit = await checkRateLimit(db, `entry:${getClientIp(request)}`, { max: 60, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit)

  const claim = verifyEntryManageTokenFromEnv(token)
  if (!claim) return fail('not_found')

  const { registration: reg, error: readErr } = await readRegistrationForMove(db, claim.registrationId)
  if (readErr) return fail('load_failed')
  if (!reg) return fail('not_found')
  const checkins = await countEntryCheckins(db, reg.id)
  if (checkins.error) return fail('load_failed')

  const block = entryMoveBlock({ registration: reg, checkinCount: checkins.count, today: dublinTodayStr() })
  if (block) {
    return NextResponse.json({ success: true, data: { can_move: false, move_blocked_reason: block.message, options: [] } })
  }

  // The entry's organisation only (a move never crosses organisations); an
  // unreadable fence fails closed.
  const loc = reg.race?.locations
  const allowedLocationIds = await moveLocationIds(db, reg.race?.location_id || null, { organizationId: loc ? (loc.organization_id || null) : undefined })
  if (!allowedLocationIds) return fail('load_failed')

  const listed = await listMoveTargets(db, { registrationId: reg.id, allowedLocationIds })
  if (!listed.ok) return fail(listed.error === 'not_found' ? 'not_found' : 'load_failed')

  return NextResponse.json({
    success: true,
    data: { can_move: true, move_blocked_reason: null, options: publicMoveOptions(listed.targets, listed.entry?.headcount) },
  })
}
