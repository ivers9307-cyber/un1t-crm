import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { getRequestOrigin } from '@/lib/app-url'
import { CONSENT_ACTIONS } from '@/lib/consent-actions'

export const runtime = 'nodejs'

// 10 attempts per IP per 15 minutes. The token is a UUID (122 bits of
// entropy), so brute force is hopeless even without a limiter — this mainly
// slows down a misconfigured email client looping on the unsubscribe URL.
// SAAS-6: deliberately tenant-UNSCOPED — the tenant is only knowable AFTER
// resolving the token, so an anti-enumeration limiter must key on IP alone.
const RL = { max: 10, windowMs: 15 * 60_000 }

// Channels accepted by the unified unsubscribe POST. Any subset can
// be passed in the body; missing body = email_marketing only
// (back-compat with Gmail's List-Unsubscribe header which POSTs
// with no body).
const UNSUB_CHANNELS = ['email_marketing', 'whatsapp_marketing', 'sms_marketing']

// One-click unsubscribe.
//
// Two callers:
//   1. Email clients that follow the List-Unsubscribe header. They
//      POST with no body — we default to email_marketing only so a
//      Gmail user clicking "Unsubscribe" doesn't accidentally lose
//      their WhatsApp / SMS marketing too.
//   2. The unified unsubscribe page (Phase 5A) at /unsubscribe/[token].
//      It POSTs `{ channels: ['email_marketing', ...] }` to opt the
//      contact out of every marketing channel they ticked.
//
// Body shape: `{ channels?: string[] }`. Unknown channel names are
// silently dropped. Empty / absent → defaults to ['email_marketing'].
//
// POST /api/unsubscribe/[token]
export async function POST(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { token } = params

  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `unsubscribe:${ip}`, RL)
  if (!limit.allowed) return rateLimitResponse(limit)

  // Parse the body if any. Tolerate empty / non-JSON for the
  // List-Unsubscribe path which doesn't always send a content-type.
  let requested = null
  try {
    const text = await request.text()
    if (text) {
      const json = JSON.parse(text)
      if (Array.isArray(json?.channels)) requested = json.channels
    }
  } catch {
    // Ignore — fall through to the default below.
  }
  let channels = (requested && requested.length
    ? requested.filter(c => UNSUB_CHANNELS.includes(c))
    : ['email_marketing'])
  if (channels.length === 0) channels = ['email_marketing']

  // LOCCOMMS.4 — `?l=` scopes the opt-out to the location whose email this was.
  //
  // NO `l` = unsubscribe from EVERY location. That is deliberate and is exact
  // back-compat: emails already delivered carry the old location-less URL, and
  // someone clicking one expects to be removed. Removing them from everything
  // is the only direction that cannot generate a spam complaint.
  const requestUrl = new URL(request.url)
  const scopeLocationId = requestUrl.searchParams.get('l') || null

  // COMMSFIX.C.4 — `?c=` names the campaign whose email carried this link.
  // Shape-checked, not looked up: a garbage value must be IGNORED, never
  // passed to increment_campaign_metric (whose UPDATE would simply match no
  // row, but a non-uuid would raise on the cast and fail the request — for a
  // metric, on the unsubscribe path, which must never fail).
  const rawCampaignId = requestUrl.searchParams.get('c')
  const campaignId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCampaignId || '')
    ? rawCampaignId
    : null

  // Find the contact preference by token
  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email, location_id)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
  }

  // Build the patch + audit log entries together. Only flip channels
  // that are currently TRUE so the consent log doesn't record
  // duplicate opt-outs for already-opted-out contacts.
  const updates = { updated_at: new Date().toISOString() }
  const logEntries = []
  const ipAddress = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || null

  // LOCCOMMS.4 — decide "is this channel currently ON?" against the row we are
  // about to write, NOT always the global one.
  //
  // Getting this wrong is silent and severe: someone opted out globally but
  // opted IN at one location (the exact shape of the leads recovered in
  // LEADCAP.1) has pref.email_marketing === false, so a scoped unsubscribe
  // would produce an EMPTY patch and their click would do nothing at all.
  let currentState = pref
  if (scopeLocationId) {
    const { data: locRow } = await db
      .from('contact_location_preferences')
      .select('email_marketing, sms_marketing, whatsapp_marketing')
      .eq('contact_id', pref.contact_id)
      .eq('location_id', scopeLocationId)
      .maybeSingle()
    // No row = they are not on that list, so there is nothing to leave.
    // Fall through with an all-false state; the response stays identical so
    // the URL is never an oracle for which lists someone is on.
    currentState = locRow || { email_marketing: false, sms_marketing: false, whatsapp_marketing: false }
  }

  for (const channel of channels) {
    if (currentState[channel] === true) {
      updates[channel] = false
      logEntries.push({
        contact_id: pref.contact_id,
        channel,
        action: CONSENT_ACTIONS.OPT_OUT,
        source: 'one_click_unsubscribe',
        ip_address: ipAddress,
      })
    }
  }

  // LOCCOMMS.4 — where the opt-out is written, and why it matters.
  //
  // A SCOPED unsubscribe must NOT touch contact_preferences. The mig 489 sync
  // trigger propagates any global channel going FALSE to ALL of that contact's
  // location rows — correct for a global opt-out, catastrophic here: leaving a
  // Hatch Street list would silently strip the person off Stillorgan's too,
  // which is the exact harm this PR exists to stop.
  //
  // So: scoped -> write only that location's row. Global -> write
  // contact_preferences and let the trigger fan the OFF out everywhere.
  const channelPatch = {}
  for (const ch of Object.keys(updates)) if (ch !== 'updated_at') channelPatch[ch] = updates[ch]
  const hasChanges = Object.keys(channelPatch).length > 0

  if (hasChanges) {
    if (scopeLocationId) {
      await db.from('contact_location_preferences')
        .update({ ...channelPatch, updated_at: updates.updated_at })
        .eq('contact_id', pref.contact_id)
        .eq('location_id', scopeLocationId)
    } else {
      await db.from('contact_preferences').update(updates).eq('id', pref.id)
    }
    if (logEntries.length) {
      await db.from('consent_log').insert(
        logEntries.map((e) => ({ ...e, location_id: scopeLocationId })),
      )
    }

    // COMMSFIX.C.4 — attribute the unsubscribe to the campaign that carried
    // the link. Gated on email_marketing having ACTUALLY flipped in this
    // request (channelPatch is built only from channels that were true), which
    // is the same replay guard the SubscriptionChange handler uses: a second
    // click, or an already-unsubscribed contact, produces an empty patch and
    // counts nothing. An SMS-only opt-out is not an email unsubscribe.
    // Best-effort — the counter must never fail someone's opt-out, and
    // supabase-js builders are thenables with no .catch.
    if (campaignId && channelPatch.email_marketing === false) {
      try {
        const { error: incErr } = await db.rpc('increment_campaign_metric', {
          p_campaign_id: campaignId,
          p_field: 'total_unsubscribed',
        })
        if (incErr) console.error('[unsubscribe] total_unsubscribed increment failed:', incErr.message)
      } catch (err) {
        console.error('[unsubscribe] total_unsubscribed increment threw:', err?.message || err)
      }
    }
  }

  // Stamp contacts.email_status only when email_marketing was actually
  // flipped — preserves the convention used by Postmark-aware filters
  // elsewhere. No equivalent contacts.* fields exist for whatsapp /
  // sms marketing; those are read off contact_preferences directly.
  // LOCCOMMS.4 — only stamp the GLOBAL email_status on a GLOBAL unsubscribe.
  // On a scoped opt-out it would be a lie: the person still receives mail from
  // their other locations, and this flag blocks manual staff sends everywhere.
  // Retiring the column entirely is PR 5, with the five readers that use it.
  // LOCCOMMS.5 — the global email_status stamp is GONE. The opt-out is recorded
  // in contact_location_preferences (globally, the mig 489 trigger fans it to
  // every location), and email_status now carries reputation only.
  //   PR 4 note retained: on a SCOPED opt-out this stamp was already skipped,
  //   because it would have blocked manual sends from every other location too.

  return NextResponse.json({
    success: true,
    message: 'Unsubscribed successfully',
    unsubscribed_channels: channels.filter(c => updates[c] === false),
  })
}

// GET redirects to preference centre. Use the request's own origin so the
// redirect always lands on the same domain the user typed — no env var
// dependency, no chance of redirecting to a stale domain.
export async function GET(request, props) {
  const params = await props.params;
  const { token } = params
  return NextResponse.redirect(`${getRequestOrigin(request)}/preferences/${token}`)
}
