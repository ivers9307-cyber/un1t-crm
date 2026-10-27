// USAGE.1 — GET /api/admin/app-usage/[profileId]: one person's app usage by
// feature for a range, and one day's session timeline with the feature trail
// (feature names only, never a record). The timeline needs the raw rows,
// which are kept 90 days; an older day answers timelineAvailable: false.
//
// SECURITY: master only, on their own session. 404 (not 403) for anyone
// outside the report's scope (a master, a deleted or inactive person, or
// someone outside the chosen tenant), so ids cannot be probed.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { uuidLike, isoDate } from '@/lib/schemas'
import { todayStrIn, addDaysIn, PLATFORM_TZ } from '@shared/zoned-time'
import { loadUsageScope, UsageScopeError } from '@/lib/app-usage/scope'
import { isUsageReportViewer, readSummary, readLastActive, readDay, parseFilters } from '@/lib/app-usage/queries'
import { rangeFor, peopleRows, featureRows, timeline } from '@/lib/app-usage/report'
import { RETENTION } from '@/lib/app-usage/rollup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const notFound = () => NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isUsageReportViewer(user)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const { profileId } = await params
  if (!uuidLike.safeParse(profileId).success) return notFound()

  const url = new URL(request.url)
  const filters = parseFilters(url)
  const nowMs = Date.now()
  const today = todayStrIn(PLATFORM_TZ, nowMs)
  const dayParam = url.searchParams.get('day')
  const day = dayParam && isoDate.safeParse(dayParam).success ? dayParam : today
  const db = createServerClient()

  try {
    const scope = await loadUsageScope(db, filters)
    const person = scope.staff.find((s) => s.id === profileId)
    if (!person) return notFound()

    const range = rangeFor(filters.rangeKey, today)
    const summary = await readSummary(db, {
      from: range.from, to: range.to, profileIds: [profileId], locationId: filters.locationId,
    })
    const lastActive = await readLastActive(db, [profileId])
    const [row] = peopleRows({ staff: [person], summary, lastActive, days: range.days, platform: filters.platform })
    const features = featureRows({ summary, days: range.days, platform: filters.platform })

    const oldestDetailDay = addDaysIn(today, -(RETENTION.rawDays - 1), PLATFORM_TZ)
    const timelineAvailable = day >= oldestDetailDay && day <= today
    let sessions = []
    if (timelineAvailable) {
      const raw = await readDay(db, { profileId, day, locationId: filters.locationId })
      const shown = filters.platform === 'all' ? raw.sessions : raw.sessions.filter((s) => s.platform === filters.platform)
      sessions = timeline({ sessions: shown, visits: raw.visits })
    }

    return NextResponse.json({
      success: true,
      data: { range, person: row, features, day, timelineAvailable, timeline: sessions },
    })
  } catch (err) {
    if (err instanceof UsageScopeError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    }
    logError('app-usage', 'person report read failed', { message: err?.message || String(err) })
    return NextResponse.json({ success: false, error: 'Could not load app usage' }, { status: 500 })
  }
}
