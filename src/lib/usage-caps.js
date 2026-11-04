// SAAS4-M2 — optional per-org hard caps (SaaS machinery plan §3).
//
// Richard's settled three-band model (2026-07-19): the plan allowance
// is a SOFT band — exceeding it accrues per-unit overage, nothing
// stops. Only an operator-set HARD cap interrupts service:
//   - ai_hard_cap_cents  → Mia pauses for new inbound (soft-handoff
//     with operator notice; the staff assistant is exempt).
//   - email_hard_cap_sends → new campaign starts are refused.
// Both live on org_settings and default NULL = no cap, so shipping
// this changes nothing until a cap is set. Plan allowances/overage
// pricing layer on top in the billing build (B1).
//
// Spend is computed LIVE from usage_events via SQL functions (mig 421)
// — the daily rollups feed the usage page, not the cap check, so there
// is no rollup-lag drift. Month boundaries are the PLATFORM billing
// calendar's (D5 = B: PLATFORM_TZ, Europe/Dublin), the same for every tenant.
//
// Both checks FAIL OPEN: a metering-infrastructure error must never
// silence Mia or block a campaign.

import { createServerClient } from '@/lib/supabase'
import { todayStrIn, zonedWallClockToInstant, PLATFORM_TZ } from '@/lib/location-time'

/**
 * First day of the billing month containing `todayStr` (default: today on
 * the platform billing calendar). D5: the platform billing calendar
 * (PLATFORM_TZ), the same for every tenant (was platformMonthStartStr; TZ.18b).
 */
export function platformMonthStartStr(todayStr = todayStrIn(PLATFORM_TZ)) {
  return `${todayStr.slice(0, 7)}-01`
}

/**
 * SAAS4-M3 — should the 80%-of-hard-cap notice go out?
 * One notice per meter per billing month (D5: PLATFORM_TZ); nothing without a cap.
 *
 * @param {{ cap: number|null, current: number, noticeMonth: string|null, month: string }} p
 *   month/noticeMonth are 'YYYY-MM' strings.
 * @returns {'send'|'skip'}
 */
export function capNoticeDecision({ cap, current, noticeMonth, month }) {
  if (!cap || cap <= 0) return 'skip'
  if (noticeMonth === month) return 'skip'
  return current >= cap * 0.8 ? 'send' : 'skip'
}

async function resolveOrgId(client, { organizationId, locationId }) {
  if (organizationId) return organizationId
  if (!locationId) return null
  const { data } = await client
    .from('locations')
    .select('organization_id')
    .eq('id', locationId)
    .maybeSingle()
  return data?.organization_id || null
}

async function readOrgCaps(client, orgId) {
  const { data } = await client
    .from('org_settings')
    .select('ai_hard_cap_cents, email_hard_cap_sends')
    .eq('organization_id', orgId)
    .maybeSingle()
  return data || {}
}

/**
 * Is the org at its hard AI-spend cap for the current Dublin month?
 * Spend excludes the staff assistant (source 'assistant_chat') per the
 * settled decision — metered, not counted.
 *
 * @returns {Promise<{capped: boolean, capCents?: number, spendCents?: number, organizationId?: string}>}
 */
export async function getAiCapStatus({ organizationId, locationId }, { db } = {}) {
  try {
    const client = db || createServerClient()
    const orgId = await resolveOrgId(client, { organizationId, locationId })
    if (!orgId) return { capped: false }

    const caps = await readOrgCaps(client, orgId)
    const capCents = caps.ai_hard_cap_cents
    if (capCents == null) return { capped: false, organizationId: orgId }

    const { data: spend, error } = await client.rpc('org_ai_spend_month_cents', {
      p_org: orgId,
      p_month_start: platformMonthStartStr(),
    })
    if (error) return { capped: false, organizationId: orgId }

    const spendCents = Number(spend) || 0
    return {
      capped: spendCents >= Number(capCents),
      capCents: Number(capCents),
      spendCents,
      organizationId: orgId,
    }
  } catch {
    return { capped: false }
  }
}

/**
 * Is the org at its hard email-send cap for the current Dublin month?
 * Counts actually-sent email_sends rows across the org's locations.
 *
 * @returns {Promise<{capped: boolean, capSends?: number, monthSends?: number, organizationId?: string}>}
 */
export async function getEmailCapStatus({ organizationId, locationId }, { db } = {}) {
  try {
    const client = db || createServerClient()
    const orgId = await resolveOrgId(client, { organizationId, locationId })
    if (!orgId) return { capped: false }

    const caps = await readOrgCaps(client, orgId)
    const capSends = caps.email_hard_cap_sends
    if (capSends == null) return { capped: false, organizationId: orgId }

    const { data: sends, error } = await client.rpc('org_email_sends_month', {
      p_org: orgId,
      p_month_start: platformMonthStartStr(),
    })
    if (error) return { capped: false, organizationId: orgId }

    const monthSends = Number(sends) || 0
    return {
      capped: monthSends >= Number(capSends),
      capSends: Number(capSends),
      monthSends,
      organizationId: orgId,
    }
  } catch {
    return { capped: false }
  }
}

const VOICE_METER = 'elevenlabs_stt_seconds'
const PAGE = 1000

/**
 * VOICENOTE.1 — has the org used its monthly voice-transcription minutes?
 * Sums usage_events.quantity (seconds) for meter 'elevenlabs_stt_seconds'
 * this platform month (D5: PLATFORM_TZ, as getAiCapStatus). Fails OPEN on
 * any read error, the same posture as the AI cap: metering trouble must not
 * silence the feature (the vendor's own billing is the backstop).
 *
 * @returns {Promise<{ capped: boolean, capMinutes: number|null, usedSeconds: number|null }>}
 */
export async function getVoiceCapStatus({ organizationId }, { db } = {}) {
  const open = { capped: false, capMinutes: null, usedSeconds: null }
  try {
    if (!organizationId) return open
    const client = db || createServerClient()
    const { data: settings, error: settingsError } = await client
      .from('org_settings')
      .select('voice_transcription_monthly_cap_minutes')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (settingsError) return open
    const capMinutes = settings?.voice_transcription_monthly_cap_minutes ?? null
    const usedSeconds = await voiceSecondsThisMonth(client, organizationId)
    if (capMinutes == null) return { capped: false, capMinutes: null, usedSeconds }
    if (usedSeconds == null) return { capped: false, capMinutes: Number(capMinutes), usedSeconds: null }
    return { capped: usedSeconds >= Number(capMinutes) * 60, capMinutes: Number(capMinutes), usedSeconds }
  } catch {
    return open
  }
}

/** Seconds transcribed this platform month for the org, or null when unreadable. */
export async function voiceSecondsThisMonth(client, organizationId) {
  return meterSumThisMonth(client, organizationId, VOICE_METER)
}

/**
 * The sum of usage_events.quantity for one meter this platform month (D5:
 * PLATFORM_TZ), paged past the 1,000-row cap. null when unreadable.
 */
export async function meterSumThisMonth(client, organizationId, meter) {
  const startMs = zonedWallClockToInstant(platformMonthStartStr(), '00:00', PLATFORM_TZ)
  if (startMs == null) return null
  const since = new Date(startMs).toISOString()
  let total = 0
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('usage_events')
      .select('quantity')
      .eq('organization_id', organizationId)
      .eq('meter', meter)
      .gte('occurred_at', since)
      .order('occurred_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return null
    const rows = data || []
    for (const r of rows) total += Number(r.quantity) || 0
    if (rows.length < PAGE) return total
  }
}

export const VOICE_REPLY_METER = 'elevenlabs_tts_replies'

/**
 * VOICEREPLY.1 — has the org sent its monthly voice replies? Counts meter
 * 'elevenlabs_tts_replies' this platform month against
 * org_settings.voice_reply_monthly_cap. Fails OPEN on any read error (the
 * transcription cap's posture): a reply still goes, as text or voice.
 *
 * @returns {Promise<{ capped: boolean, cap: number|null, used: number|null }>}
 */
export async function getVoiceReplyCapStatus({ organizationId }, { db } = {}) {
  const open = { capped: false, cap: null, used: null }
  try {
    if (!organizationId) return open
    const client = db || createServerClient()
    const { data: settings, error } = await client
      .from('org_settings')
      .select('voice_reply_monthly_cap')
      .eq('organization_id', organizationId)
      .maybeSingle()
    if (error) return open
    const cap = settings?.voice_reply_monthly_cap ?? null
    const used = await meterSumThisMonth(client, organizationId, VOICE_REPLY_METER)
    if (cap == null) return { capped: false, cap: null, used }
    if (used == null) return { capped: false, cap: Number(cap), used: null }
    return { capped: used >= Number(cap), cap: Number(cap), used }
  } catch {
    return open
  }
}
