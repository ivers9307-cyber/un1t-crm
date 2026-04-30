// /api/cars/[id]/promote — move a car forward through the workflow.
//
// Body: { to: 'pending' | 'completed' }
//
// Promotion to 'pending'  — manual step the operator triggers when
//                            a buyer is in play. No checks beyond
//                            the car existing.
// Promotion to 'completed' — gated by completionGaps() so the
//                            checklist of invoices / VAT refund /
//                            buyer details / Xero invoice is enforced
//                            server-side. UI shows the same checks
//                            inline; the API is the security boundary.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { completionGaps } from '@/lib/cars'

const PromoteSchema = z.object({
  to: z.enum(['new', 'pending', 'completed']),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const validation = await validateBody(request, PromoteSchema)
  if (!validation.ok) return validation.response
  const { to } = validation.data

  const db = createServerClient()
  const { data: car } = await db
    .from('cars')
    .select('*, car_documents(doc_type)')
    .eq('id', params.id)
    .single()
  if (!car) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccess(user, car.location_id)
  if (guard) return guard

  if (to === 'completed') {
    const gaps = completionGaps(car)
    if (gaps.length) {
      return NextResponse.json({
        success: false,
        error: 'Cannot complete yet — outstanding items: ' + gaps.join(', '),
        gaps,
      }, { status: 400 })
    }
  }

  const updates = { status: to }
  if (to === 'completed') updates.completed_at = new Date().toISOString()
  if (to !== 'completed') updates.completed_at = null

  const { data, error } = await db
    .from('cars')
    .update(updates)
    .eq('id', params.id)
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
