import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey } from '@/lib/api-auth'
import { overlayConnections, syncConnectionFromLegacy } from '@/lib/connection-registry'
import { validateBody } from '@/lib/validate'

const IntegrationsUpdateSchema = z.object({
  glofox: z.unknown().nullable().optional(),
  webhooks: z.unknown().nullable().optional(),
})

// GET /api/locations/[id]/integrations — Get integration credentials for a location
// Used by n8n to fetch Glofox API keys, webhook URLs, etc. per location
export async function GET(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const db = createServerClient()
  const { data, error } = await db
    .from('locations')
    .select('id, name, slug, settings, organization_id')
    .eq('id', params.id)
    .single()

  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  // APIKEYS.3 — per-org key may only read its own org's location.
  if (auth.orgId && data.organization_id !== auth.orgId) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }

  // INTEG-A2 dual-read: registry glofox row replaces settings.glofox
  // when present, so n8n sees the same config the app reads.
  const overlaid = await overlayConnections(db, data, ['glofox'])

  // Return integration settings (glofox, etc.)
  return NextResponse.json({
    success: true,
    data: {
      location_id: overlaid.id,
      location_name: overlaid.name,
      location_slug: overlaid.slug,
      glofox: overlaid.settings?.glofox || null,
      webhooks: overlaid.settings?.webhooks || null,
    },
  })
}

// PUT /api/locations/[id]/integrations — Update integration credentials
export async function PUT(request, props) {
  const params = await props.params;
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, IntegrationsUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Get current settings
  const { data: location } = await db
    .from('locations')
    .select('settings, organization_id')
    .eq('id', params.id)
    .single()

  if (!location) {
    return NextResponse.json({ success: false, error: 'Location not found' }, { status: 404 })
  }
  // APIKEYS.3 — per-org key may only update its own org's location.
  if (auth.orgId && location.organization_id !== auth.orgId) {
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

  // INTEG-A2 dual-write: re-sync the registry glofox row after a
  // legacy settings.glofox write. Non-fatal — legacy remains the
  // written source of truth this phase.
  if (body.glofox !== undefined) {
    try {
      await syncConnectionFromLegacy(db, params.id, 'glofox', data)
    } catch (e) {
      console.error('[locations/integrations] registry sync failed:', e?.message || e)
    }
  }

  return NextResponse.json({ success: true, data })
}
