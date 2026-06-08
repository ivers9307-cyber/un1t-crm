import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  location_id: uuidLike,
  location_resource: z.string().min(1).max(300),
  location_title: z.string().max(300).nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('google_business_connections')
    .update({ location_resource: body.location_resource, location_title: body.location_title ?? null })
    .eq('location_id', body.location_id)
    .select('location_id, location_resource, location_title')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
