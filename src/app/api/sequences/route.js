import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/sequences — list sequences
export async function GET(request) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  let query = db.from('email_sequences')
    .select('*, sequence_steps(count)')
    .order('created_at', { ascending: false })

  if (locationId) query = query.eq('location_id', locationId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, sequences: data })
}

// POST /api/sequences — create sequence
export async function POST(request) {
  const db = createServerClient()
  const body = await request.json()

  const { data, error } = await db.from('email_sequences').insert({
    name: body.name || 'Untitled Sequence',
    description: body.description || null,
    trigger_type: body.trigger_type || 'manual',
    trigger_config: body.trigger_config || {},
    status: 'draft',
    location_id: body.location_id,
    created_by: body.created_by,
  }).select().single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, sequence: data })
}
