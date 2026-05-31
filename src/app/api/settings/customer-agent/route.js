import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'

// RADAR-AGENT.0 — customer agent settings. Stored on
// locations.settings.customer_agent (jsonb), mirroring ai_assistant.
// Manager+ at the active location may edit. Ships OFF by default — the
// blob is absent until an owner saves, and `enabled` defaults false.

const DEFAULTS = {
  enabled: false,
  test_mode: false,
  test_phones: [],
  tone: null,
  extra_rules: null,
  holding_message: null,
  quiet_hours: null,
}

const SettingsSchema = z.object({
  enabled: z.boolean(),
  test_mode: z.boolean().optional().default(false),
  test_phones: z.array(z.string().max(32)).max(20).optional().default([]),
  tone: z.string().max(2000).nullable().optional(),
  extra_rules: z.string().max(2000).nullable().optional(),
  holding_message: z.string().max(500).nullable().optional(),
  quiet_hours: z.object({
    start: z.string().regex(/^\d{1,2}:\d{2}$/),
    end: z.string().regex(/^\d{1,2}:\d{2}$/),
    tz: z.string().max(64).optional().default('Europe/Dublin'),
  }).nullable().optional(),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const settings = { ...DEFAULTS, ...(loc?.settings?.customer_agent || {}) }
  return NextResponse.json({ success: true, settings })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const v = await validateBody(request, SettingsSchema)
  if (!v.ok) return v.response

  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).single()
  const settings = loc?.settings || {}
  settings.customer_agent = {
    enabled: v.data.enabled,
    test_mode: !!v.data.test_mode,
    test_phones: (v.data.test_phones || []).map(s => s.trim()).filter(Boolean),
    tone: v.data.tone?.trim() || null,
    extra_rules: v.data.extra_rules?.trim() || null,
    holding_message: v.data.holding_message?.trim() || null,
    quiet_hours: v.data.quiet_hours || null,
  }

  await db.from('locations').update({ settings }).eq('id', locationId).select('id').single()
  return NextResponse.json({ success: true, settings: settings.customer_agent })
}
