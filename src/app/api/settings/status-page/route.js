// GET/PUT /api/settings/status-page — operator copy for the public member
// status page (STATUS-PAGE.2). Stored on locations.settings.status_page
// (jsonb), the exact override shape buildStatusView() reads. Session-guarded,
// `settings` permission. Blank fields are dropped (pruneStatusOverrides) so
// they transparently fall back to the shipped defaults.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { DEFAULT_COPY, pruneStatusOverrides } from '@/lib/status-page'

export const runtime = 'nodejs'

const line = z.string().max(300).nullable().optional()
const svc = z.object({ label: line, ok: line, bad: line }).partial().optional()
const verdict = z.object({ tag: line, headline: line, subline: line }).partial().optional()

const Schema = z.object({
  brand: z.string().max(60).nullable().optional(),
  services: z.object({ booking: svc, messaging: svc, payments: svc, email: svc }).partial().optional(),
  verdict: z.object({ operational: verdict, degraded: verdict, down: verdict }).partial().optional(),
})

async function requireSettings() {
  const user = await getCurrentUser()
  if (!user) return { error: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  if (!hasPermission(user, 'settings')) {
    return { error: NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 }) }
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return { error: NextResponse.json({ success: false, error: 'No active location' }, { status: 400 }) }
  return { user, locationId }
}

export async function GET() {
  const gate = await requireSettings()
  if (gate.error) return gate.error
  const db = createServerClient()

  const { data: loc } = await db.from('locations').select('name, settings').eq('id', gate.locationId).single()
  // Public URL for the preview link — resolved by public_path like the page.
  const { data: lp } = await db
    .from('landing_page_settings')
    .select('public_path')
    .eq('location_id', gate.locationId)
    .maybeSingle()

  return NextResponse.json({
    success: true,
    overrides: loc?.settings?.status_page || {},
    defaults: DEFAULT_COPY,
    publicPath: lp?.public_path || null,
    location: { id: gate.locationId, name: loc?.name || null },
  })
}

export async function PUT(request) {
  const gate = await requireSettings()
  if (gate.error) return gate.error

  const v = await validateBody(request, Schema)
  if (!v.ok) return v.response

  const overrides = pruneStatusOverrides(v.data)

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', gate.locationId).single()
  const settings = loc?.settings || {}
  if (Object.keys(overrides).length) settings.status_page = overrides
  else delete settings.status_page // fully-default → drop the key entirely

  await db.from('locations').update({ settings }).eq('id', gate.locationId).select('id').single()
  return NextResponse.json({ success: true, overrides })
}
