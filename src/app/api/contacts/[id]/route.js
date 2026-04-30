import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { email, phone, leadSourceSchema, leadStatusSchema } from '@/lib/schemas'

const ContactUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  first_name: z.string().max(100).nullable().optional(),
  last_name: z.string().max(100).nullable().optional(),
  email: email.optional(),
  phone: phone.nullable().optional(),
  label: z.string().max(100).nullable().optional(),
  glofox_member_id: z.string().max(100).nullable().optional(),
  trial_credits_remaining: z.number().int().min(0).max(100).optional(),
  lead_source: leadSourceSchema.optional(),
  lead_status: leadStatusSchema.optional(),
})

// PUT /api/contacts/:id — Update a contact (replaces Pipedrive PUT /v1/persons/:id)
export async function PUT(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const validation = await validateBody(request, ContactUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Only forward keys actually present (Zod with .optional() leaves undefined keys out).
  const updates = {}
  for (const [key, value] of Object.entries(body)) {
    updates[key] = value
  }

  const { data, error } = await db.from('contacts').update(updates).eq('id', id).select().single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}

// GET /api/contacts/:id
export async function GET(request, { params }) {
  const authError = requireApiKey(request)
  if (authError) return authError

  const { id } = params
  const db = createServerClient()
  const { data, error } = await db.from('contacts').select('*').eq('id', id).single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 404 })
  }

  return NextResponse.json({ success: true, data })
}
