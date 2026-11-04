// SAAS4-M3 — org usage summary shared by /api/settings/org-usage and
// the /settings/usage page (one query/aggregation path, two callers).

import { platformMonthStartStr, voiceSecondsThisMonth, meterSumThisMonth, VOICE_REPLY_METER } from '@/lib/usage-caps'

/** Pure: fold month rollup rows into per-meter + per-location totals. */
export function aggregateRollups(rows) {
  const meters = {}
  const byLocation = {}
  for (const row of rows || []) {
    const m = (meters[row.meter] ||= { quantity: 0, cost_cents: 0 })
    m.quantity += Number(row.quantity) || 0
    m.cost_cents += Number(row.cost_cents) || 0
    const loc = (byLocation[row.location_id] ||= { name: row.locations?.name || row.location_id, meters: {} })
    const lm = (loc.meters[row.meter] ||= { quantity: 0, cost_cents: 0 })
    lm.quantity += Number(row.quantity) || 0
    lm.cost_cents += Number(row.cost_cents) || 0
  }
  return { meters, byLocation }
}

// Month rollups can exceed the PostgREST 1k cap for larger orgs
// (locations × 4 meters × ≤31 days) — .range()-paginate with an
// explicit order (the pipeline-reclassify pattern).
async function fetchMonthRollups(db, orgId, monthStart) {
  const PAGE = 1000
  const rows = []
  for (let from = 0; ; from += PAGE) {
    const { data } = await db
      .from('usage_rollups_daily')
      .select('location_id, meter, day, quantity, cost_cents, locations(name)')
      .eq('organization_id', orgId)
      .gte('day', monthStart)
      .order('day', { ascending: true })
      .order('location_id', { ascending: true })
      .order('meter', { ascending: true })
      .range(from, from + PAGE - 1)
    rows.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return rows
}

/**
 * Full month-to-date summary for one org: live cap-relevant numbers
 * (mig 421 RPCs) + nightly rollup totals + the configured hard caps.
 */
export async function getOrgUsageSummary(db, orgId) {
  const monthStart = platformMonthStartStr()

  const [{ data: settings }, { data: aiSpend }, { data: emailSends }, rollups, voiceSeconds, voiceReplies] =
    await Promise.all([
      db.from('org_settings')
        .select('ai_hard_cap_cents, email_hard_cap_sends, ops_alert_emails, ai_cap_notice_month, email_cap_notice_month, voice_transcription_enabled, voice_transcription_monthly_cap_minutes, voice_reply_mode, voice_reply_test_phones, voice_reply_monthly_cap')
        .eq('organization_id', orgId)
        .maybeSingle(),
      db.rpc('org_ai_spend_month_cents', { p_org: orgId, p_month_start: monthStart }),
      db.rpc('org_email_sends_month', { p_org: orgId, p_month_start: monthStart }),
      fetchMonthRollups(db, orgId, monthStart),
      // VOICENOTE.1 — live from usage_events (the rollup is nightly); null
      // when unreadable, so the card never shows a wrong 0.
      voiceSecondsThisMonth(db, orgId).catch(() => null),
      meterSumThisMonth(db, orgId, VOICE_REPLY_METER).catch(() => null),
    ])

  const { meters, byLocation } = aggregateRollups(rollups || [])
  return {
    organization_id: orgId,
    month_start: monthStart,
    live: {
      ai_spend_cents: Number(aiSpend) || 0,
      email_sends: Number(emailSends) || 0,
    },
    caps: {
      ai_hard_cap_cents: settings?.ai_hard_cap_cents ?? null,
      email_hard_cap_sends: settings?.email_hard_cap_sends ?? null,
      ops_alert_emails: settings?.ops_alert_emails ?? null,
    },
    // VOICENOTE.1 — WhatsApp voice-note transcription (ElevenLabs).
    voice: {
      enabled: settings?.voice_transcription_enabled === true,
      capMinutes: settings?.voice_transcription_monthly_cap_minutes ?? null,
      usedMinutes: voiceSeconds == null ? null : Math.ceil(voiceSeconds / 60),
    },
    // VOICEREPLY.1 — Mia's voice replies (ElevenLabs text to speech).
    voiceReplies: {
      mode: settings?.voice_reply_mode || 'off',
      testPhones: Array.isArray(settings?.voice_reply_test_phones) ? settings.voice_reply_test_phones : [],
      cap: settings?.voice_reply_monthly_cap ?? null,
      usedThisMonth: voiceReplies == null ? null : voiceReplies,
    },
    meters,
    by_location: byLocation,
  }
}
