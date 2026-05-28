import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, assertCreateInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const NoteCreateSchema = z.object({
  contact_id: uuidLike.optional(),
  person_id: uuidLike.optional(),  // legacy alias accepted
  deal_id: uuidLike.nullable().optional(),
  content: z.string().min(1).max(20_000),
  location_id: uuidLike.optional(),
}).refine(d => d.contact_id || d.person_id, {
  message: 'contact_id (or legacy person_id) is required',
  path: ['contact_id'],
})

// POST /api/notes — Create a note (replaces Pipedrive POST /v1/notes)
export async function POST(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, NoteCreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // APIKEYS.3 — per-org key may only create within its org.
  const scopeErr = await assertCreateInOrg({ db, orgId: auth.orgId, locationId: body.location_id, contactId: body.contact_id || body.person_id })
  if (scopeErr) return scopeErr

  const { data, error } = await db.from('notes').insert({
    contact_id: body.contact_id || body.person_id,  // accept either name
    deal_id: body.deal_id,
    content: body.content,
    ...(body.location_id ? { location_id: body.location_id } : {}),
  }).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
