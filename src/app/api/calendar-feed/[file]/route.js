// src/app/api/calendar-feed/[file]/route.js
// ICSFEED.1 — GET /api/calendar-feed/<token>.ics — a person's own published
// shifts as an iCalendar feed, for Apple, Google and Outlook to subscribe to.
//
// ANONYMOUS BY DESIGN. Calendar apps poll a URL and can hold no session, so
// the rcf_ token in the path IS the credential (256 random bits; only its
// sha256 is stored, mig 632). Public via the proxy's publicExactPaths
// ('/api/calendar-feed', segment-matched) and check:route-guards EXEMPT. NOT on
// the brand or tenant allowlists: the URL is always minted on the CRM host.
//
// ANSWERS
//   404  not a token, unknown, replaced, turned off, or the person is
//        deactivated or deleted. ONE answer for all of them, so the response
//        says nothing about which.
//   429  this token over FEED_TOKEN_RL (per token, never per IP: Google fetches
//        every feed from shared egress — the UNSUB-RL.1 lesson).
//   503  a read failed. NEVER an empty 200: a subscribed calendar replaces its
//        whole copy with each fetch, so an empty body would delete every shift
//        from every subscriber's phone on a database blip.
//   200  text/calendar. private, max-age=900: no shared cache ever holds it, so
//        a replaced or turned-off link stops at once server-side.
// HEAD is answered by Next from this GET.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { dublinTodayStr } from '@/lib/dublin-time'
import { tokenFromFeedFile } from '@/lib/calendar-feed-token'
import { buildStaffShiftFeed, feedWindow } from '@/lib/staff-calendar-feed'
import {
  FEED_TOKEN_RL, resolveCalendarFeed, loadFeedShifts, touchFeedFetched,
} from '@/lib/staff-calendar-feed-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function notFound() {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  })
}

function unavailable() {
  return new NextResponse('Calendar temporarily unavailable', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '900' },
  })
}

export async function GET(request, props) {
  const { file } = await props.params
  const token = tokenFromFeedFile(file)
  if (!token) return notFound()

  const db = createServerClient()
  const resolved = await resolveCalendarFeed(db, token)
  if (resolved.status === 'error') return unavailable()
  if (resolved.status !== 'ok') return notFound()

  const limit = await checkRateLimit(db, `calfeed:token:${resolved.tokenHash.slice(0, 32)}`, FEED_TOKEN_RL)
  if (!limit.allowed) return rateLimitResponse(limit)

  const nowMs = Date.now()
  const { rows, locationsById, error } = await loadFeedShifts(db, resolved.feed.profile_id, feedWindow(dublinTodayStr()))
  if (error) return unavailable()

  const body = buildStaffShiftFeed({ rows, locationsById, generatedAtMs: nowMs })
  await touchFeedFetched(db, resolved.feed, nowMs)

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="shifts.ics"',
      'Cache-Control': 'private, max-age=900',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}
