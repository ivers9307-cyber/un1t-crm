// HYROX-STYLE — PUT /api/hyrox/settings: operator editor for the Hyrox
// charter + house style + style examples, stored on locations.settings.hyrox
// (jsonb). Read-modify-write so sibling settings keys are never clobbered.
// Collection-style write (location_id in the body) — Forbidden (403) on a
// missing per-location grant, unlike the detail routes' 404 IDOR posture.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { MAX_STORED_EXAMPLES, MAX_STORED_EXAMPLE_CHARS } from '@/lib/hyrox/constants'

export const dynamic = 'force-dynamic'

const ExampleSchema = z.object({
  id: z.string().max(64).optional(),
  source: z.enum(['pasted', 'generated']).default('pasted'),
  label: z.string().max(120).optional(),
  text: z.string().min(1).max(MAX_STORED_EXAMPLE_CHARS),
  added_at: z.string().optional(),
})
const SettingsSchema = z.object({
  location_id: uuidLike,
  charter: z.string().max(8000).nullish(),
  house_style: z.string().max(8000).nullish(),
  style_examples: z.array(ExampleSchema).max(MAX_STORED_EXAMPLES).optional(),
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, SettingsSchema)
  if (!v.ok) return v.response
  const body = v.data
  if (!hasPermissionForLocation(user, body.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('id, settings').eq('id', body.location_id).single()
  const settings = { ...(loc?.settings || {}) }
  const hyrox = { ...(settings.hyrox || {}) }
  if (body.charter !== undefined) hyrox.charter = body.charter || null
  if (body.house_style !== undefined) hyrox.house_style = body.house_style || null
  if (body.style_examples !== undefined) hyrox.style_examples = body.style_examples
  settings.hyrox = hyrox
  const { error } = await db.from('locations').update({ settings }).eq('id', body.location_id).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { hyrox } })
}
