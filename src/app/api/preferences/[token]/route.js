import { createServerClient } from '@/lib/supabase'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { consentActionFor } from '@/lib/consent-actions'
import {
  REFUSAL_REASONS,
  guardBeforeTokenLookup,
  penaliseInvalidToken,
  guardResolvedToken,
  recordRefusedOptOut,
} from '@/lib/consent-token-guard'

const PreferencesUpdateSchema = z.object({
  // LOCCOMMS.4 — when present, the update applies to THAT location's list only.
  // Absent = the global row, which the mig 489 trigger then fans out to every
  // location (the "unsubscribe from everything" control).
  locationId: z.string().optional(),
  email_marketing: z.boolean().optional(),
  email_administrative: z.boolean().optional(),
  whatsapp_marketing: z.boolean().optional(),
  whatsapp_administrative: z.boolean().optional(),
  // SMS toggles (mig 063 added administrative; mig 064 added marketing).
  sms_marketing: z.boolean().optional(),
  sms_administrative: z.boolean().optional(),
})

export const runtime = 'nodejs'

// UNSUB-RL.1 — this route carried the same defect as /api/unsubscribe: a flat
// per-IP limiter (20 / 15 min) shared by GET and PUT, spent before the token
// was resolved. The preference centre is reached by a human clicking a link in
// an email, so it is less exposed than the RFC 8058 POST — but a corporate NAT
// or carrier CGNAT still puts many recipients of one campaign behind one
// egress IP, and 20 requests covers roughly four visits between them. Past
// that, somebody adjusting their consent got a 429 and their change was lost
// with nothing written.
//
// Same split as the unsubscribe route: per-IP budget for tokens that do NOT
// resolve, per-token budget for tokens that do. See @/lib/consent-token-guard.
//
// `contact_preferences.unsubscribe_token` is `UUID DEFAULT gen_random_uuid()`
// (mig 005), so a non-UUID cannot resolve and is rejected without a query.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The shared front half of both handlers: shape-check, per-IP peek, resolve,
 * per-token budget. Returns either `{ refused: Response }` or `{ pref }`.
 *
 * Factored out because GET and PUT must budget identically — when they were
 * two copies sharing one IP bucket, loading the page spent from the same
 * allowance as saving it.
 */
async function resolveTokenOrRefuse(db, request, token) {
  const ip = getClientIp(request)
  const userAgent = request.headers.get('user-agent') || null
  const refusal = (reason, extra = {}) => recordRefusedOptOut(db, {
    endpoint: 'preferences', reason, ip, token, userAgent, ...extra,
  })
  const notFound = () => NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })

  if (!UUID_RE.test(token || '')) {
    await penaliseInvalidToken(db, 'preferences', ip)
    await refusal(REFUSAL_REASONS.INVALID_TOKEN)
    return { refused: notFound() }
  }

  const ipBudget = await guardBeforeTokenLookup(db, 'preferences', ip)
  if (!ipBudget.allowed) {
    await refusal(REFUSAL_REASONS.IP_ENUMERATION)
    return { refused: rateLimitResponse(ipBudget) }
  }

  const { data: pref, error } = await db
    .from('contact_preferences')
    .select('*, contacts(id, name, email)')
    .eq('unsubscribe_token', token)
    .single()

  if (error || !pref) {
    await penaliseInvalidToken(db, 'preferences', ip)
    await refusal(REFUSAL_REASONS.INVALID_TOKEN)
    return { refused: notFound() }
  }

  const tokenBudget = await guardResolvedToken(db, 'preferences', token)
  if (!tokenBudget.allowed) {
    await refusal(REFUSAL_REASONS.TOKEN_FLOOD, { contactId: pref.contact_id })
    return { refused: rateLimitResponse(tokenBudget) }
  }

  return { pref, ip }
}

// GET /api/preferences/[token] — fetch current preferences
export async function GET(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { token } = params

  const gate = await resolveTokenOrRefuse(db, request, token)
  if (gate.refused) return gate.refused
  const { pref } = gate

  // LOCCOMMS.4 — every list this person is actually on. Each location is a
  // standalone business, so leaving one must not remove them from the others;
  // showing all of them is what makes that legible instead of surprising.
  const { data: locRows } = await db
    .from('contact_location_preferences')
    .select('location_id, email_marketing, sms_marketing, whatsapp_marketing, locations(name)')
    .eq('contact_id', pref.contact_id)

  const lists = (locRows || [])
    .map((r) => ({
      locationId: r.location_id,
      locationName: r.locations?.name || 'UN1T',
      email_marketing: r.email_marketing,
      sms_marketing: r.sms_marketing,
      whatsapp_marketing: r.whatsapp_marketing,
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName))

  return NextResponse.json({
    success: true,
    contact: {
      name: pref.contacts?.name,
      email: pref.contacts?.email,
    },
    lists,
    preferences: {
      email_marketing: pref.email_marketing,
      email_administrative: pref.email_administrative,
      whatsapp_marketing: pref.whatsapp_marketing,
      whatsapp_administrative: pref.whatsapp_administrative,
      sms_marketing: pref.sms_marketing,
      sms_administrative: pref.sms_administrative,
    },
  })
}

// PUT /api/preferences/[token] — update preferences
export async function PUT(request, props) {
  const params = await props.params;
  const db = createServerClient()
  const { token } = params

  const gate = await resolveTokenOrRefuse(db, request, token)
  if (gate.refused) return gate.refused
  const { pref, ip } = gate

  const validation = await validateBody(request, PreferencesUpdateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const allowed = [
    'email_marketing', 'email_administrative',
    'whatsapp_marketing', 'whatsapp_administrative',
    'sms_marketing', 'sms_administrative',
  ]
  const updates = {}
  const logEntries = []

  // LOCCOMMS.4 — a scoped update compares against THAT location's row, not the
  // global one. Someone opted out globally but opted in at one location (the
  // shape of the leads recovered in LEADCAP.1) would otherwise produce an empty
  // patch and their change would silently do nothing.
  let current = pref
  if (body.locationId) {
    const { data: locRow } = await db
      .from('contact_location_preferences')
      .select('email_marketing, sms_marketing, whatsapp_marketing')
      .eq('contact_id', pref.contact_id)
      .eq('location_id', body.locationId)
      .maybeSingle()
    if (!locRow) {
      return NextResponse.json({ success: false, error: 'Invalid token' }, { status: 404 })
    }
    current = locRow
  }

  for (const channel of allowed) {
    if (typeof body[channel] === 'boolean' && body[channel] !== current[channel]) {
      updates[channel] = body[channel]
      logEntries.push({
        contact_id: pref.contact_id,
        channel,
        action: consentActionFor(body[channel]),
        source: 'preference_centre',
        ip_address: ip,
        location_id: body.locationId || null,
      })
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: true, message: 'No changes' })
  }

  updates.updated_at = new Date().toISOString()

  // LOCCOMMS.4 — scoped writes go to the location row ONLY. Writing
  // contact_preferences would trip the mig 489 trigger, which fans any channel
  // going FALSE out to every location — turning "leave the Hatch list" into
  // "leave every UN1T list", which is the harm this PR exists to prevent.
  if (body.locationId) {
    await db
      .from('contact_location_preferences')
      .update(updates)
      .eq('contact_id', pref.contact_id)
      .eq('location_id', body.locationId)
  } else {
    await db
      .from('contact_preferences')
      .update(updates)
      .eq('id', pref.id)
  }

  // Log all changes to consent audit trail
  if (logEntries.length > 0) {
    await db.from('consent_log').insert(logEntries)
  }

  // Update contact email_status if email_marketing was changed
  if (typeof updates.email_marketing === 'boolean') {
    // LOCCOMMS.5 — no longer stamps 'unsubscribed'. email_status carries
    // reputation only (active | bounced | complained); the opt-out itself lives
    // in contact_location_preferences.
    const contactUpdate = updates.email_marketing ? { email_status: 'active' } : null
    // EMAIL-HYGIENE.1 — explicit re-consent also clears the engagement-
    // hygiene suppression stamp (contacts.email_suppressed_at, mig 395):
    // a contact actively saying "send me marketing" outranks our
    // 90-day-non-opener call. Opt-out leaves the stamp alone (the consent
    // gate already excludes them; if they re-consent later this branch
    // clears it then).
    if (updates.email_marketing === true) contactUpdate.email_suppressed_at = null
    // COMMSFIX.A.3 — on an opt-out contactUpdate is null (nothing to write
    // since LOCCOMMS.5 retired the 'unsubscribed' stamp); running
    // .update(null) anyway was a guaranteed-failing PATCH on every opt-out.
    if (contactUpdate) {
      await db
        .from('contacts')
        .update(contactUpdate)
        .eq('id', pref.contact_id)
    }
  }

  return NextResponse.json({ success: true, message: 'Preferences updated' })
}
