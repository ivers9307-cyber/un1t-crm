import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess , getUserLocationIds} from '@/lib/auth'
import { generateReport } from '@/lib/report-generator'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, reportTypeSchema , MANAGER_ROLES} from '@/lib/schemas'

const ReportRunSchema = z.object({
  report_type: reportTypeSchema,
  period_start: isoDate,
  period_end: isoDate,
  location_id: uuidLike.optional(),
})

// GET /api/schedule/reports?location_id=xxx — List generated reports
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  let query = db.from('generated_reports')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)

  if (locationId) {
    query = query.eq('location_id', locationId)
  } else {
    const userLocationIds = getUserLocationIds(user)
    if (userLocationIds.length === 0) return NextResponse.json({ success: true, data: [] })
    query = query.in('location_id', userLocationIds)
  }

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/reports — Generate a report on demand
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const validation = await validateBody(request, ReportRunSchema)
  if (!validation.ok) return validation.response
  const { report_type, period_start, period_end, location_id } = validation.data
  const locId = location_id || user.activeLocation?.id

  const guard = assertLocationAccess(user, locId)
  if (guard) return guard

  const result = await generateReport({
    report_type,
    period_start,
    period_end,
    location_id: locId,
    generated_by: user.id,
  })

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: result.data }, { status: 201 })
}
