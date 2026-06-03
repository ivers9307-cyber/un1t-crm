// POST /api/churn-radar/refresh-member  { contact_id }
//
// RADAR-PAY.2 — per-row "re-pull from Glofox" for the churn radar.
// Force-syncs ONE member straight from Glofox so an account the
// operator has just resolved in Glofox (took payment, unlocked) drops
// off the Overdue / at-risk list immediately, instead of waiting for
// the 03:00 UTC glofox-sync cron (or an inbound webhook that may never
// fire for a manual resolution).
//
// It doubles as the safety check before dunning: refresh first, and
// anyone who's actually paid leaves the list before a payment reminder
// can reach them — the payment_reminder action re-derives trouble from
// the contacts row, so a fresh pull is what makes that check current.
//
// Scoped to the churn_radar permission + the caller's active location
// (same gate as the radar action route) — unlike the master-only
// /api/glofox/sync-member debug endpoint, which this deliberately does
// NOT reuse (wrong auth tier, GET/dry-run debug shape, Glofox-id input).

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { glofoxFetch, glofoxCredentialsForLocation } from '@/lib/glofox'
import { applyMemberSync } from '@/lib/glofox-sync'
import { classifyContact, paymentTroubleKind } from '@/lib/churn-radar'
import { invalidateRadar } from '@/lib/radar-cache'
import { logWarn, logInfo } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Columns classifyContact() + paymentTroubleKind() read to decide
// whether the freshly-synced member still belongs on the radar.
const STATE_COLUMNS =
  'glofox_membership_status, glofox_membership_type, glofox_membership_state, ' +
  'glofox_billing_interval, last_payment_at, last_attended_at, last_booked_at, ' +
  'trial_credits_remaining, glofox_membership_expiry'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  if (!hasPermission(user, 'churn_radar')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  let body
  try { body = await request.json() } catch { body = {} }
  const contactId = String(body?.contact_id || '').trim()
  if (!contactId) {
    return NextResponse.json({ success: false, error: 'contact_id is required' }, { status: 400 })
  }

  const db = createServerClient()

  // Scope the contact to the caller's active location + get its Glofox link.
  const { data: contact } = await db
    .from('contacts')
    .select('id, location_id, glofox_member_id')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact || contact.location_id !== locationId) {
    return NextResponse.json({ success: false, error: 'Contact not in your active location' }, { status: 404 })
  }
  if (!contact.glofox_member_id) {
    return NextResponse.json({
      success: false,
      error: "This member isn't linked to Glofox, so there's nothing to re-pull.",
    }, { status: 400 })
  }

  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (!creds.branchId || !creds.apiKey || !creds.apiToken) {
    return NextResponse.json({
      success: false,
      error: 'Glofox credentials are not configured for this location.',
    }, { status: 400 })
  }

  // Pull the single member straight from Glofox (GET /2.0/members/{id}).
  let glofoxRes, glofoxBody
  try {
    glofoxRes = await glofoxFetch(creds, `/2.0/members/${encodeURIComponent(contact.glofox_member_id)}`)
    try { glofoxBody = await glofoxRes.json() } catch { glofoxBody = null }
  } catch (e) {
    logWarn('churn-radar', 'glofox refresh fetch failed', { err: e, contactId })
    return NextResponse.json({ success: false, error: 'Could not reach Glofox — try again in a moment.' }, { status: 502 })
  }
  if (!glofoxRes.ok) {
    return NextResponse.json({
      success: false,
      error: glofoxBody?.error || glofoxBody?.message || `Glofox returned HTTP ${glofoxRes.status}`,
    }, { status: 502 })
  }
  const member = glofoxBody?.data || glofoxBody?.member || glofoxBody

  const applied = await applyMemberSync(db, locationId, member, { creds })
  if (applied?.error || applied?.action === 'ambiguous' || applied?.action === 'invalid') {
    return NextResponse.json({
      success: false,
      error: 'Could not apply the Glofox update for this member.',
    }, { status: 502 })
  }

  // The membership_state may have changed — drop the cached radar
  // surfaces so the next read reflects it instead of waiting out the TTL.
  invalidateRadar('churn', locationId)

  // Re-read the now-current state so the UI knows whether the member
  // stays on the list or drops off.
  const { data: fresh } = await db
    .from('contacts')
    .select(STATE_COLUMNS)
    .eq('id', contactId)
    .maybeSingle()
  const classification = classifyContact(fresh || {})
  const trouble = paymentTroubleKind(fresh || {})

  logInfo('churn-radar', 'member refreshed from glofox', { contactId, classification, trouble })
  return NextResponse.json({
    success: true,
    data: {
      contact_id: contactId,
      state: fresh?.glofox_membership_state || null,
      classification,                       // 'overdue' | 'paused' | 'active' | 'quarantine' | 'out'
      payment_trouble: trouble,             // 'overdue' | 'slipping' | null
      still_flagged: classification === 'overdue' || trouble !== null,
    },
  })
}
