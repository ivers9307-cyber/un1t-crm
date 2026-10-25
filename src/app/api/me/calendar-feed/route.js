// src/app/api/me/calendar-feed/route.js
// ICSFEED.1 — the caller's OWN calendar link.
//
//   GET     { active, created_at, rotated_at, last_fetched_at }. Never the URL:
//           only its hash is stored (mig 632), so it cannot be shown again.
//   POST    { replace?: boolean } → { url, webcal_url, google_url, replaced }.
//           The ONLY time the URL exists outside the person's calendar app.
//           An existing link without replace:true is 409 feed_exists, so a
//           double tap or a second device never silently kills the first one.
//   DELETE  turn it off (idempotent).
//
// SCOPE: the service-role client, so `.eq('profile_id', user.id)` inside the
// IO module IS the gate. No id parameter exists; a body naming one is refused
// by the strict schema. Every staff member may subscribe to their own shifts,
// so there is no permission key (check:mobile-parity has nothing to pair).
//
// IMPERSONATION: POST and DELETE refuse while a master views as someone. A
// minted link is a long-lived secret; making one for another person would land
// it in the master's browser.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { getAppUrl } from '@/lib/app-url'
import { logError } from '@/lib/log'
import { calendarFeedUrls } from '@/lib/calendar-feed-token'
import { getCalendarFeedStatus, issueCalendarFeed, revokeCalendarFeed } from '@/lib/staff-calendar-feed-server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }
const IssueSchema = z.object({ replace: z.boolean().optional() }).strict()

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}
const unauthorized = () => json({ success: false, error: 'Unauthorized' }, 401)
const viewingAsSomeone = (user) => !!(user.impersonatingFrom || user.supportSession?.impersonatedUserId)
const impersonating = () => json({
  success: false,
  error: 'A calendar link can only be made or turned off by the person it belongs to, not while viewing as them.',
}, 403)

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  const db = createServerClient()
  const { data, error } = await getCalendarFeedStatus(db, user.id)
  if (error) {
    logError('calendar-feed', 'status read failed', { err: error })
    return json({ success: false, error: 'Could not read your calendar link.' }, 500)
  }
  return json({ success: true, data })
}

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  if (viewingAsSomeone(user)) return impersonating()

  const validation = await validateBody(request, IssueSchema, { allowEmpty: true })
  if (!validation.ok) return validation.response

  // Resolve the origin BEFORE minting, so a misconfigured deploy cannot leave a
  // live link behind that nobody was ever shown.
  let base
  try {
    base = getAppUrl()
  } catch (e) {
    logError('calendar-feed', 'NEXT_PUBLIC_APP_URL is not set', { err: e })
    return json({ success: false, error: 'Calendar links are not configured on this server.' }, 500)
  }

  const db = createServerClient()
  const result = await issueCalendarFeed(db, user.id, { replace: validation.data.replace === true })
  if (result.conflict) {
    return json({
      success: false,
      code: 'feed_exists',
      error: 'You already have a calendar link. Make a new one to replace it.',
    }, 409)
  }
  if (result.error) {
    logError('calendar-feed', 'issue failed', { err: result.error })
    return json({ success: false, error: 'Could not make your calendar link.' }, 500)
  }
  return json({ success: true, data: { ...calendarFeedUrls(base, result.token), replaced: result.replaced } })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user) return unauthorized()
  if (viewingAsSomeone(user)) return impersonating()

  const db = createServerClient()
  const { revoked, error } = await revokeCalendarFeed(db, user.id)
  if (error) {
    logError('calendar-feed', 'revoke failed', { err: error })
    return json({ success: false, error: 'Could not turn off your calendar link.' }, 500)
  }
  return json({ success: true, data: { revoked } })
}
