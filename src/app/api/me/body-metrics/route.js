// POST /api/me/body-metrics — a champ-app member saves their own body metrics
// (gender, weight, dob). Writes ONLY the caller's contact (resolved from their
// Supabase JWT). Stamps profile_setup_completed_at once dob+gender+weight all set.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'
import { applyWeightObservation } from '@/lib/body-metrics'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  gender: z.enum(['female', 'male', 'other']).optional(),
  weight_kg: z.number().min(20).max(300).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict()

export async function POST(request) {
  const resolved = await resolveCustomerContact(request)
  if (resolved.error) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const contactId = resolved.contact.id

  const v = await validateBody(request, Body)
  if (!v.ok) return v.response
  const { gender, weight_kg, dob } = v.data

  const db = createServerClient()
  const nowIso = new Date().toISOString()

  const patch = {}
  if (gender !== undefined) patch.gender = gender
  if (dob !== undefined) patch.dob = dob
  if (Object.keys(patch).length) {
    const { error } = await db.from('contacts').update(patch).eq('id', contactId)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  if (weight_kg !== undefined) {
    await applyWeightObservation(db, { contactId, weightKg: weight_kg, source: 'manual', observedAt: nowIso })
  }

  const { data: row } = await db
    .from('contacts')
    .select('dob, gender, weight_kg, profile_setup_completed_at')
    .eq('id', contactId).maybeSingle()
  if (row && row.dob && row.gender && row.weight_kg != null && !row.profile_setup_completed_at) {
    await db.from('contacts').update({ profile_setup_completed_at: nowIso }).eq('id', contactId)
    row.profile_setup_completed_at = nowIso
  }

  return NextResponse.json({
    success: true,
    data: {
      dob: row?.dob ?? null, gender: row?.gender ?? null, weight_kg: row?.weight_kg ?? null,
      profile_setup_completed_at: row?.profile_setup_completed_at ?? null,
    },
  })
}
