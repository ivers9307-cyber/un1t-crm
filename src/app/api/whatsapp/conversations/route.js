import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'

// GET /api/whatsapp/conversations — list conversations (inbox)
export async function GET(request) {
  const db = createServerClient()
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id')

  let query = db.from('whatsapp_conversations')
    .select('*, contacts(id, name, first_name, phone, wa_phone, lead_status)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(50)

  if (locationId) query = query.eq('location_id', locationId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, conversations: data })
}
