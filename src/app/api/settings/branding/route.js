import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'

const BrandingSchema = z.object({
  location_id: z.string().uuid().optional(),
  logo_url: z.string().url().max(2000).nullable().optional(),
  favicon_url: z.string().url().max(2000).nullable().optional(),
  company_name: z.string().max(200).nullable().optional(),
})

// GET /api/settings/branding?location_id=xxx — Get branding for a location
export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data } = await db.from('company_settings')
    .select('*')
    .eq('location_id', locationId)
    .single()

  return NextResponse.json({ success: true, data: data || null })
}

// PUT /api/settings/branding — Update branding (owner only)
export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'owner') {
    return NextResponse.json({ success: false, error: 'Only owners can update branding' }, { status: 403 })
  }

  const validation = await validateBody(request, BrandingSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id

  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()

  const record = {
    location_id: locationId,
    logo_url: body.logo_url ?? null,
    favicon_url: body.favicon_url ?? null,
    company_name: body.company_name ?? null,
    updated_at: new Date().toISOString(),
    updated_by: user.id,
  }

  // Upsert — create if doesn't exist, update if it does
  const { data, error } = await db.from('company_settings')
    .upsert(record, { onConflict: 'location_id' })
    .select()
    .single()

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}
