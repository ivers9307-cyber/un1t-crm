import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'

const IntegrationsUpdateSchema = z.object({
  glofox: z.unknown().nullable().optional(),
  webhooks: z.unknown().nullable().optional(),
})

// GET /api/locations/[id]/integrations — Get integration credentials for a location
// Used by n8n to fetch Glofox API keys, webhook URLs, etc. per location
export async function GET(request, props) {
  const params = await props.params;
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db
    .from('locations')
    .select('id, name, slug, settings')
    .eq('id', params.id)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  // Return integration settings (glofox, etc.)
  return NextResponse.json({
    success: true,
    data: {
      location_id: data.id,
      location_name: data.name,
      location_slug: data.slug,
      glofox: data.settings?.glofox || null,
      webhooks: data.settings?.webhooks || null,
    },
  })
}

// PUT /api/locations/[id]/integrations — Update integration credentials
export async function PUT(request, props) {
  const params = await props.params;
  const authError = requireApiKey(request)
  if (authError) return authError

  const validation = await validateBody(request, IntegrationsUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Get current settings
  const { data: location } = await db
    .from('locations')
    .select('settings')
    .eq('id', params.id)
    .single()

  if (!location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  // Merge new integration settings into existing settings
  const updatedSettings = {
    ...(location.settings || {}),
    ...(body.glofox !== undefined ? { glofox: body.glofox } : {}),
    ...(body.webhooks !== undefined ? { webhooks: body.webhooks } : {}),
  }

  const { data, error } = await db
    .from('locations')
    .update({ settings: updatedSettings, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data })
}
