import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { applyAudienceFilterAsync, InvalidAudienceFilterError } from '@/lib/audience-filter'
import { audienceFilterSchema } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/contacts/search?term=email@example.com&fields=email
// Replaces Pipedrive GET /v1/persons/search
export async function GET(request) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { searchParams } = new URL(request.url)
  const term = searchParams.get('term') || ''
  const fields = searchParams.get('fields') || 'email'
  const limit = parseInt(searchParams.get('limit') || '10')
  const db = createServerClient()

  let query = db.from('contacts').select('*')

  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)

  if (fields === 'email') {
    query = query.ilike('email', `%${term}%`)
  } else {
    query = query.or(`name.ilike.%${term}%,email.ilike.%${term}%,phone.ilike.%${term}%`)
  }

  const { data, error } = await query.limit(limit)

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  // Match Pipedrive's response shape so n8n code nodes need minimal changes
  return NextResponse.json({
    success: true,
    data: {
      items: (data || []).map(item => ({ item }))
    }
  })
}

// POST /api/contacts/search
//
// Cookie-auth richer search used by the /contacts page advanced
// filter UI. Body: { filter, search, limit, offset, location_id }.
// Reuses applyAudienceFilter so the same field/op allowlist + safety
// guarantees apply that campaigns / broadcasts get.
//
// Returns the page slice + total matched count so the table can
// render and the operator can see how many rows the criteria match.
const SearchBody = z.object({
  filter: audienceFilterSchema,
  search: z.string().max(200).optional(),
  // .nullable() so the client can send location_id: null when no
  // active location is set (vs. omitting the key). The route falls
  // back to user.activeLocation?.id below. Pre-fix, null tripped the
  // .uuid() validator and returned "location_id: Invalid input".
  location_id: z.string().uuid().nullable().optional(),
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const raw = await request.json().catch(() => ({}))
  const parsed = SearchBody.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({
      success: false,
      error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    }, { status: 400 })
  }

  const locationId = parsed.data.location_id || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  const limit = parsed.data.limit ?? 100
  const offset = parsed.data.offset ?? 0

  const db = createServerClient()
  // Two queries — one for the page slice, one for the total count.
  // The count uses head:true so Postgres returns the count without
  // shipping rows back. Both share the same WHERE so the count
  // reflects what the operator actually sees.
  let listQuery = db.from('contacts')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  let countQuery = db.from('contacts')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId)

  // Free-text search applies on top of the audience filter — it's a
  // separate name/email substring match, not part of the filter
  // schema. Both queries get it.
  if (parsed.data.search?.trim()) {
    const s = parsed.data.search.trim()
    listQuery = listQuery.or(`name.ilike.%${s}%,email.ilike.%${s}%`)
    countQuery = countQuery.or(`name.ilike.%${s}%,email.ilike.%${s}%`)
  }

  try {
    // Async path supports the new `tag` field (Phase 3 — mig 085).
    listQuery = await applyAudienceFilterAsync({ db, query: listQuery, filter: parsed.data.filter, locationId })
    countQuery = await applyAudienceFilterAsync({ db, query: countQuery, filter: parsed.data.filter, locationId })
  } catch (e) {
    if (e instanceof InvalidAudienceFilterError) {
      return NextResponse.json({ success: false, error: e.message }, { status: 400 })
    }
    throw e
  }

  const [listRes, countRes] = await Promise.all([listQuery, countQuery])

  if (listRes.error) {
    return NextResponse.json({ success: false, error: listRes.error.message }, { status: 500 })
  }
  if (countRes.error) {
    return NextResponse.json({ success: false, error: countRes.error.message }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    contacts: listRes.data || [],
    count: countRes.count ?? 0,
    limit,
    offset,
  })
}
