import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ hidden: z.boolean() })

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const { id } = await params
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: review } = await db
    .from('google_reviews')
    .select('id, location_id')
    .eq('id', id)
    .maybeSingle()
  // 404 (not 403) on miss/cross-tenant so ids can't be enumerated.
  if (!review) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccess(user, review.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, review.location_id, 'landing_page')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const { data, error } = await db
    .from('google_reviews')
    .update({ hidden: validation.data.hidden })
    .eq('id', id)
    .select('id, hidden')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
