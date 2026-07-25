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
  // C2 — instant greeting sent when someone opens the chat without typing
  // (request_welcome). Null → code default (DEFAULT_WELCOME_GREETING).
  welcome_greeting: null,
  // C3 — label on the tappable button of cta_url link messages.
  // Null → code default ('Open link').
  link_button_text: null,
  quiet_hours: null,
  limits: null,
  monthly_points_target: null,
  // AGENT-HANDS.1 — class-booking autonomy. 'auto' (default) books a
  // verified member's class immediately; 'draft' queues it for a
  // one-tap staff approval (which executes it). Consultations are
  // always autonomous. consultation_event_type_id optionally pins the
  // consultation booking type (otherwise name-matched consult/intro/
  // taster).
  booking_mode: 'auto',
  agent_name: 'Mia',
  membership_signup_url: null,
  membership_cta_label: null,
  followups: { enabled: false, nudge_after_hours: 3, template_name: null, daily_cap: 50 },
  first_class_checkin: { enabled: false, delay_hours: 2, template_name: null, daily_cap: 20 },
  // INBOX-APPROVALS-AI.4 — Wave 3 inline suggestion after approvals.
  // Absent/enabled-undefined means ON (the suggest route only treats an
  // explicit `enabled === false` as off); default true here matches that.
  inline_suggestion: { enabled: true },
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
  welcome_greeting: z.string().max(500).nullable().optional(),
  link_button_text: z.string().max(25).nullable().optional(),
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
  agent_name: z.string().max(40).nullable().optional(),
  membership_signup_url: z.string().url().max(512).nullable().optional()
    .or(z.literal('').transform(() => null)),
  membership_cta_label: z.string().max(60).nullable().optional(),
  followups: z.object({
    enabled: z.boolean().optional().default(false),
    nudge_after_hours: z.number().min(1).max(18).optional().default(3),
    template_name: z.string().max(512).nullable().optional(),
    daily_cap: z.number().min(1).max(500).optional().default(50),
  }).nullable().optional(),
  first_class_checkin: z.object({
    enabled: z.boolean().optional().default(false),
    delay_hours: z.number().min(1).max(24).optional().default(2),
    template_name: z.string().max(512).nullable().optional(),
    daily_cap: z.number().min(1).max(200).optional().default(20),
  }).nullable().optional(),
  inline_suggestion: z.object({
    enabled: z.boolean().optional().default(true),
  }).nullable().optional(),
  handoff_cooldown_hours: z.number().min(0).max(168).nullable().optional(),
  consultation_event_type_id: z.string().max(64).nullable().optional(),
  monthly_points_target: z.number().int().min(0).nullable().optional(),
  social_enabled: z.boolean().optional().default(false),
})

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data: loc } = await db.from('locations').select('name, settings').eq('id', locationId).single()
  const settings = {
    ...DEFAULTS,
    ...(loc?.settings?.customer_agent || {}),
    // social_enabled lives top-level on locations.settings (sibling of customer_agent)
    social_enabled: loc?.settings?.social_enabled === true,
  }

  // AGENT-CHECKIN.2 — visibility for the First-class check-in card. The
  // sequence-engine incidents (CHANGELOG #289/#291) proved a silent
  // automation is undebuggable from the UI: surface sent-today/total, the
  // last outcome, and the last cron tick's skip-reason tally (persisted on
  // the agent-followups heartbeat). UTC day boundary matches the daily-cap
  // counter in lib/agent/followups.js on purpose.
  const now = new Date()
  const todayStartIso = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const [todayRes, totalRes, lastRes, hbRes] = await Promise.all([
    db.from('contacts').select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).gte('first_class_checkin_at', todayStartIso),
    db.from('contacts').select('id', { count: 'exact', head: true })
      .eq('location_id', locationId).not('first_class_checkin_at', 'is', null),
    db.from('activities').select('note, created_at, contacts!contact_id(name)')
      .eq('location_id', locationId).eq('type', 'agent_checkin')
      .order('created_at', { ascending: false }).limit(1),
    db.from('cron_heartbeats').select('last_ok_at, last_outcome').eq('name', 'agent-followups').maybeSingle(),
  ])
  const lastRow = lastRes.data?.[0] || null
  const checkinStats = {
    sent_today: todayRes.count || 0,
    total: totalRes.count || 0,
    last: lastRow
      ? { at: lastRow.created_at, note: lastRow.note || null, contact_name: lastRow.contacts?.name || null }
      : null,
    last_run: hbRes.data
      ? { at: hbRes.data.last_ok_at, checkins: hbRes.data.last_outcome?.checkins || null }
      : null,
  }

  return NextResponse.json({
    success: true,
    settings,
    // Live-despite-test-mode tripwire: `enabled` + `test_mode` together mean
    // the agent answers EVERY customer (the allowlist only scopes an agent
    // that is not enabled). Deliberate semantics, surfaced so the UI can warn
    // the operator who believes test mode still scopes it.
    live_despite_test_mode: settings.enabled === true && settings.test_mode === true,
    checkin_stats: checkinStats,
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
  // FIX 2026-06-12: this object is built field-by-field, and the
  // followups / first_class_checkin / agent_name / handoff_cooldown
  // keys were validated but never WRITTEN — the UI said "Saved ✓"
  // while the route dropped them. Every SettingsSchema field must
  // appear here; the schema is the contract.
  settings.customer_agent = {
    enabled: v.data.enabled,
    test_mode: !!v.data.test_mode,
    test_phones: (v.data.test_phones || []).map(s => s.trim()).filter(Boolean),
    tone: v.data.tone?.trim() || null,
    extra_rules: v.data.extra_rules?.trim() || null,
    holding_message: v.data.holding_message?.trim() || null,
    welcome_greeting: v.data.welcome_greeting?.trim() || null,
    link_button_text: v.data.link_button_text?.trim() || null,
    quiet_hours: v.data.quiet_hours || null,
    limits: v.data.limits || null,
    booking_mode: v.data.booking_mode === 'draft' ? 'draft' : 'auto',
    agent_name: v.data.agent_name?.trim() || DEFAULTS.agent_name,
    membership_signup_url: v.data.membership_signup_url || null,
    membership_cta_label: v.data.membership_cta_label?.trim() || null,
    handoff_cooldown_hours: v.data.handoff_cooldown_hours ?? DEFAULTS.handoff_cooldown_hours,
    followups: { ...DEFAULTS.followups, ...(v.data.followups || {}) },
    first_class_checkin: { ...DEFAULTS.first_class_checkin, ...(v.data.first_class_checkin || {}) },
    inline_suggestion: { ...DEFAULTS.inline_suggestion, ...(v.data.inline_suggestion || {}) },
    consultation_event_type_id: v.data.consultation_event_type_id || null,
    monthly_points_target: v.data.monthly_points_target ?? null,
  }
  // social_enabled lives top-level on locations.settings (sibling of customer_agent),
  // NOT nested inside customer_agent — written here so it's merged safely.
  settings.social_enabled = !!v.data.social_enabled

  await db.from('locations').update({ settings }).eq('id', locationId).select('id').single()
  return NextResponse.json({ success: true, settings: settings.customer_agent })
}
