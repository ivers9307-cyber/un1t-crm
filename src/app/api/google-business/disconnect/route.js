import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ location_id: uuidLike })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard

  const db = createServerClient()
  const { error } = await db
    .from('google_business_connections')
    .delete()
    .eq('location_id', validation.data.location_id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
