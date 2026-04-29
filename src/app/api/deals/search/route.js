import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'

// GET /api/deals/search?term=email@example.com&fields=contact_email
// Replaces Pipedrive GET /v1/deals/search
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const term = searchParams.get('term') || ''
  const limit = parseInt(searchParams.get('limit') || '10')
  const db = createServerClient()

  const locationId = searchParams.get('location_id')

  // Search deals by contact email (most common n8n use case)
  let contactQuery = db.from('contacts').select('id').ilike('email', `%${term}%`).limit(1)
  if (locationId) contactQuery = contactQuery.eq('location_id', locationId)
  const { data: contacts } = await contactQuery

  if (!contacts || contacts.length === 0) {
    return NextResponse.json({ success: true, data: { items: [] } })
  }

  const { data: deals, error } = await db.from('deals')
    .select('*')
    .eq('contact_id', contacts[0].id)
    .eq('status', 'open')
    .limit(limit)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Match Pipedrive response shape
  return NextResponse.json({
    success: true,
    data: {
      items: (deals || []).map(item => ({ item }))
    }
  })
}
