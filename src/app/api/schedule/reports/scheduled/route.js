import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { calculateNextRun } from '@/lib/report-generator'

// GET /api/schedule/reports/scheduled — List scheduled reports
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.from('scheduled_reports')
    .select('*, profiles:created_by(full_name)')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

// POST /api/schedule/reports/scheduled — Create a scheduled report
export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const body = await request.json()
  const db = createServerClient()

  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const record = {
    location_id: locationId,
    created_by: user.id,
    report_type: body.report_type,
    report_name: body.report_name,
    frequency: body.frequency,
    day_of_week: body.day_of_week ?? null,
    day_of_month: body.day_of_month ?? null,
    deliver_email: body.deliver_email || false,
    email_recipients: body.email_recipients || [],
    deliver_notification: body.deliver_notification ?? true,
    parameters: body.parameters || {},
    active: true,
  }

  // Calculate next_run_at using the shared helper
  record.next_run_at = calculateNextRun(record.frequency, record.day_of_week, record.day_of_month)

  const { data, error } = await db.from('scheduled_reports').insert(record).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}

// DELETE /api/schedule/reports/scheduled?id=xxx — Deactivate a scheduled report
export async function DELETE(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 })

  const db = createServerClient()

  // Verify the scheduled report belongs to a location the caller can manage.
  const { data: report } = await db.from('scheduled_reports')
    .select('location_id')
    .eq('id', id)
    .single()
  if (!report) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccess(user, report.location_id)
  if (guard) return guard

  const { error } = await db.from('scheduled_reports')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
