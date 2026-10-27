// USAGE.1 — GET /api/admin/app-usage: the App usage report for the platform
// console (/admin/app-usage). People ("Who") or features ("By feature") for
// a range, a platform, and optionally one tenant and one studio.
//
// SECURITY: master only, on their own session (never while viewing as
// someone or in a support session). Service-role reads: this gate is the
// whole of the access control. The report is cross-tenant on purpose (it is
// a platform console page, Richard 26 Oct 2026); the tenant filter narrows
// it, and a studio outside the chosen tenant is a 400.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { UsageScopeError } from '@/lib/app-usage/scope'
import { isUsageReportViewer, readLastActive, parseFilters, loadReportData } from '@/lib/app-usage/queries'
import { peopleRows, featureRows, reportTotals } from '@/lib/app-usage/report'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!isUsageReportViewer(user)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const filters = parseFilters(url)
  const view = url.searchParams.get('view') === 'features' ? 'features' : 'people'
  const db = createServerClient()

  try {
    const { range, scope, staff, summary } = await loadReportData(db, filters)
    const inScope = new Set(staff.map((s) => s.id))
    const scopedSummary = summary.filter((r) => inScope.has(r.profile_id))
    const lastActive = await readLastActive(db, staff.map((s) => s.id))
    const people = peopleRows({ staff, summary: scopedSummary, lastActive, days: range.days, platform: filters.platform })
    const features = featureRows({ summary: scopedSummary, days: range.days, platform: filters.platform })
    return NextResponse.json({
      success: true,
      data: {
        range,
        view,
        platform: filters.platform,
        rows: view === 'features' ? features : people,
        totals: reportTotals({ people, features }),
        organizations: scope.organizations,
        locations: scope.locations,
      },
    })
  } catch (err) {
    if (err instanceof UsageScopeError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 })
    }
    logError('app-usage', 'report read failed', { message: err?.message || String(err) })
    return NextResponse.json({ success: false, error: 'Could not load app usage' }, { status: 500 })
  }
}
