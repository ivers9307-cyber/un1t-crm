import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

// GET /api/public/events/:slug — Public: get event type details + form fields
// No auth required — this powers the public booking page
export async function GET(request, { params }) {
  const db = createServerClient()

  const { data, error } = await db.from('event_types')
    .select('id, name, slug, description, duration_minutes, color, availability, buffer_minutes, max_advance_days, custom_fields')
    .eq('slug', params.slug)
    .eq('active', true)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}
