import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES } from '@/lib/schemas'
// MIA-HYGIENE.1 — schema, defaults and the persisted-object builder live in
// one contract module so a unit test can assert every validated key is
// actually WRITTEN (see settings-contract.js for the two incidents this
// prevents).
import {
  DEFAULTS,
  SettingsSchema,
  buildCustomerAgentSettings,
} from '@/lib/agent/settings-contract'

// RADAR-AGENT.0 — customer agent settings. Stored on
// locations.settings.customer_agent (jsonb), mirroring ai_assistant.
// Manager+ at the active location may edit. Ships OFF by default — the
// blob is absent until an owner saves, and `enabled` defaults false.

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  const { data: loc } = await db.from('locations').select('name, settings, glofox_auto_cancel_memberships').eq('id', locationId).single()
  const settings = {
    ...DEFAULTS,
    ...(loc?.settings?.customer_agent || {}),
    // social_enabled lives top-level on locations.settings (sibling of customer_agent)
    social_enabled: loc?.settings?.social_enabled === true,
    // CANCEL-FORM.2 — the Glofox auto-cancel toggle is its own column (mig 584).
    glofox_auto_cancel: loc?.glofox_auto_cancel_memberships === true,
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
  // MIA-HYGIENE.1 — ONE writer, in the contract module. This object used to be
  // assembled field-by-field right here, and twice a validated key never made
  // it in (#495; then effort / handoff_after_verify_failures). The schema is
  // the contract, and settings-contract.test.js now enforces it.
  settings.customer_agent = buildCustomerAgentSettings(v.data)
  // social_enabled lives top-level on locations.settings (sibling of customer_agent),
  // NOT nested inside customer_agent — written here so it's merged safely.
  settings.social_enabled = !!v.data.social_enabled

  // CANCEL-FORM.2 — glofox_auto_cancel_memberships is a COLUMN, written in the
  // same UPDATE. Always written (false when omitted) so an old editor that
  // never sends the key can't leave a stale true behind.
  const { error } = await db.from('locations')
    .update({ settings, glofox_auto_cancel_memberships: v.data.glofox_auto_cancel === true })
    .eq('id', locationId).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, settings: settings.customer_agent })
}
