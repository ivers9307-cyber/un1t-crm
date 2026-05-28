import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgLocationIds } from '@/lib/api-auth'

// GET /api/deals/search?term=email@example.com&fields=contact_email
// Replaces Pipedrive GET /v1/deals/search
export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const term = searchParams.get('term') || ''
  const limit = parseInt(searchParams.get('limit') || '10')
  const db = createServerClient()

  const locationId = searchParams.get('location_id')

  // Search deals by contact email (most common n8n use case)
  let contactQuery = db.from('contacts').select('id').ilike('email', `%${term}%`).limit(1)
  if (locationId) contactQuery = contactQuery.eq('location_id', locationId)
  // APIKEYS.3 — per-org key: only resolve contacts within the org's
  // locations, so the deal search can't reach another org's data.
  if (auth.orgId) {
    const locIds = await orgLocationIds(db, auth.orgId)
    contactQuery = contactQuery.in('location_id', locIds.length ? locIds : ['00000000-0000-0000-0000-000000000000'])
  }
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
