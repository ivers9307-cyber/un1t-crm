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
  limits: null,
  // AGENT-HANDS.1 — class-booking autonomy. 'auto' (default) books a
  // verified member's class immediately; 'draft' queues it for a
  // one-tap staff approval (which executes it). Consultations are
  // always autonomous. consultation_event_type_id optionally pins the
  // consultation booking type (otherwise name-matched consult/intro/
  // taster).
  booking_mode: 'auto',
  handoff_cooldown_hours: 12,
  consultation_event_type_id: null,
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
  // Cost/abuse ceilings. Omitted → code defaults (20/conv/hr, 500/loc/day).
  limits: z.object({
    max_replies_per_conversation_per_hour: z.number().int().min(1).max(1000).optional(),
    max_replies_per_location_per_day: z.number().int().min(1).max(100000).optional(),
  }).nullable().optional(),
  booking_mode: z.enum(['auto', 'draft']).optional().default('auto'),
  handoff_cooldown_hours: z.number().min(0).max(168).nullable().optional(),
  consultation_event_type_id: z.string().max(64).nullable().optional(),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data: loc } = await db.from('locations').select('name, settings').eq('id', locationId).single()
  const settings = { ...DEFAULTS, ...(loc?.settings?.customer_agent || {}) }
  return NextResponse.json({
    success: true,
    settings,
    location: { id: locationId, name: loc?.name || null },
  })
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
    limits: v.data.limits || null,
    booking_mode: v.data.booking_mode === 'draft' ? 'draft' : 'auto',
    consultation_event_type_id: v.data.consultation_event_type_id || null,
  }

  await db.from('locations').update({ settings }).eq('id', locationId).select('id').single()
  return NextResponse.json({ success: true, settings: settings.customer_agent })
}
