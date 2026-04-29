import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'

// GET /api/schedule/reports/scheduled — List scheduled reports
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !['owner', 'manager', 'head_coach'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
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

  const record = {
    location_id: body.location_id || user.activeLocation?.id,
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

  // Calculate next_run_at
  const now = new Date()
  if (record.frequency === 'weekly' && record.day_of_week != null) {
    const target = new Date(now)
    const diff = (record.day_of_week - target.getDay() + 7) % 7 || 7
    target.setDate(target.getDate() + diff)
    target.setHours(7, 0, 0, 0) // 7 AM
    record.next_run_at = target.toISOString()
  } else if (record.frequency === 'monthly' && record.day_of_month) {
    const target = new Date(now.getFullYear(), now.getMonth() + 1, record.day_of_month, 7, 0, 0)
    record.next_run_at = target.toISOString()
  }

  const { data, error } = await db.from('scheduled_reports').insert(record).select().single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data }, { status: 201 })
}
