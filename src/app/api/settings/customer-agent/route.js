import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { canEditMiaSettings } from '@/lib/agent/settings-access'
import { readCheckinSendsToday, readCheckinSendsAllTime } from '@/lib/agent/checkin-counts'
import { logError } from '@/lib/log'
import { mergeLocationSettings, settingsSaveFailure } from '@/lib/location-settings'
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
// MIAROLE.1 (C80) — only an owner at the active location, or a master, may
// edit; anyone who can open the page may read. Ships OFF by default — the
// blob is absent until an owner saves, and `enabled` defaults false.

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  // SETTINGSWIPE.1 — a failed read is NOT "Mia on her defaults". Answering
  // { ...DEFAULTS } here showed enabled:false as her saved state, and the
  // editor's Save wrote it back, switching her off.
  const { data: loc, error: locErr } = await db.from('locations').select('name, settings, glofox_auto_cancel_memberships').eq('id', locationId).single()
  if (locErr || !loc) {
    logError('settings-customer-agent', 'settings read failed', { locationId, err: locErr?.message || 'no row' })
    return NextResponse.json({
      success: false,
      code: 'settings_unreadable',
      error: 'Could not load the customer agent settings just now.',
    }, { status: 500 })
  }
  const settings = {
    ...DEFAULTS,
    ...(loc?.settings?.customer_agent || {}),
    // social_enabled lives top-level on locations.settings (sibling of customer_agent)
    social_enabled: loc?.settings?.social_enabled === true,
    // CANCEL-FORM.2 — the Glofox auto-cancel toggle is its own column (mig 585).
    glofox_auto_cancel: loc?.glofox_auto_cancel_memberships === true,
  }

  // AGENT-CHECKIN.2 — visibility for the First-class check-in card. The
  // sequence-engine incidents (CHANGELOG #289/#291) proved a silent
  // automation is undebuggable from the UI: surface sent-today/total, the
  // last outcome, and the last cron tick's skip-reason tally (persisted on
  // the agent-followups heartbeat).
  // CHECKINRISKS.1 (C106 c) — sent-today and total count SENDS, read by the
  // runner's own daily-cap counter (src/lib/agent/checkin-counts.js), so the
  // card's "Sent today N/cap" is the number the cap is judged on. They used to
  // count contacts STAMPED, and a skip stamps too. A failed read is null.
  const [todayRes, totalRes, lastRes, hbRes] = await Promise.all([
    readCheckinSendsToday(db, locationId),
    readCheckinSendsAllTime(db, locationId),
    db.from('activities').select('note, created_at, contacts!contact_id(name)')
      .eq('location_id', locationId).eq('type', 'agent_checkin')
      .order('created_at', { ascending: false }).limit(1),
    db.from('cron_heartbeats').select('last_ok_at, last_outcome').eq('name', 'agent-followups').maybeSingle(),
  ])
  for (const [what, res] of [['sent_today', todayRes], ['total', totalRes], ['last', lastRes]]) {
    if (res.error) logError('settings-customer-agent', 'check-in stats read failed', { locationId, what, err: res.error })
  }
  const lastRow = lastRes.data?.[0] || null
  const checkinStats = {
    sent_today: todayRes.count,
    total: totalRes.count,
    // A failed read of the last outcome is not "none yet".
    last_unreadable: !!lastRes.error,
    last: lastRow
      ? { at: lastRow.created_at, note: lastRow.note || null, contact_name: lastRow.contacts?.name || null }
      : null,
    last_run: hbRes.data
      ? {
          at: hbRes.data.last_ok_at,
          checkins: hbRes.data.last_outcome?.checkins || null,
          // CHECKINSTALL.1 — the per-Dublin-day rollup (and the day before),
          // so the card still explains a quiet day after 20:00.
          day: hbRes.data.last_outcome?.checkins_day || null,
        }
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
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  // MIAROLE.1 (C80, the owner's call 30 Sep) — membership first (404, so a
  // caller not at the studio learns nothing), then the role AT this studio.
  // This used to be MANAGER_ROLES off `user.role`, which let head coaches and
  // managers switch Mia on, off or into test mode, and judged the caller's
  // highest role anywhere rather than the one held at the studio written.
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!canEditMiaSettings(user, locationId)) {
    return NextResponse.json({ success: false, error: 'Only an owner can change the customer agent settings.' }, { status: 403 })
  }
  const db = createServerClient()

  const v = await validateBody(request, SettingsSchema)
  if (!v.ok) return v.response

  // MIA-HYGIENE.1 — ONE writer of the blob, in the contract module (#495;
  // then effort / handoff_after_verify_failures); settings-contract.test.js
  // enforces it. social_enabled lives top-level on locations.settings (a
  // sibling of customer_agent). CANCEL-FORM.2 — glofox_auto_cancel_memberships
  // is a COLUMN written in the same UPDATE, always (false when omitted) so an
  // old editor can't leave a stale true behind.
  // SETTINGSWIPE.1 — through mergeLocationSettings: this used to discard its
  // read error and write the WHOLE settings column back, wiping every other
  // key (Glofox credentials, UniFi, CAPI…) on a blip.
  const saved = await mergeLocationSettings(db, locationId, (settings) => {
    settings.customer_agent = buildCustomerAgentSettings(v.data)
    settings.social_enabled = !!v.data.social_enabled
    return settings
  }, {
    alsoSet: { glofox_auto_cancel_memberships: v.data.glofox_auto_cancel === true },
    scope: 'settings-customer-agent',
  })
  if (!saved.ok) return settingsSaveFailure(saved)
  return NextResponse.json({ success: true, settings: saved.settings.customer_agent })
}
