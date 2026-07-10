// POST /api/public/host-list/[slug]/subscribe
//
// Public mailing-list signup for an event host's list (HOST-EMAIL.2). No
// auth — same posture as /api/public/races/[slug]/register: per-IP rate
// limit + Zod body + slug lookup (404 on unknown slug; slugs are public).
//
// Flow: find-or-create the contact at the host's ANCHOR location (the
// synthetic location every host gets for its events — provisioned lazily
// via ensureAnchorLocation), apply marketing consent TRUE (this form IS the
// explicit opt-in — same applyFormMarketingConsent the event register route
// uses: contact_preferences three channels + consent_log + email_status
// mirror), upsert host_contacts membership (source='mailing_list',
// insert-once), and tag the contact with the host tag in BOTH systems —
// contacts.tags text[] (import-style append-if-missing) AND contact_tags
// (writeContactTag: idempotent + fires tag_added sequences).
//
// ENUMERATION: once the slug resolves and the body validates, the response
// is ALWAYS { success: true } — a duplicate signup, an existing contact, or
// an internal write failure all look identical from outside (failures are
// logged server-side). Nothing here reveals whether an email is known.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { ensureAnchorLocation } from '@/lib/host-events'
import { hostTagFor } from '@/lib/host-contact-list'
import { writeContactTag } from '@/lib/contact-tags'
import { applyFormMarketingConsent } from '@/lib/marketing-consent'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

const SubscribeSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().email().max(320),
})

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()

  // Same limiter class as the public register route (5 per IP / 15 min).
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `host-list:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many signup attempts. Please wait a few minutes and try again.')
  }

  const validation = await validateBody(request, SubscribeSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Host by slug. Signup is allowed pre-verification (the list can grow
  // while the sending domain's DNS is pending) — only the slug must exist.
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, slug, organization_id, anchor_location_id')
    .eq('slug', params.slug)
    .maybeSingle()
  if (!host) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  try {
    const locationId = host.anchor_location_id || await ensureAnchorLocation(db, host)

    // Find-or-create mirrors the event register route: match the email
    // globally so an existing member/attendee links to their real contact
    // (dedup keeps consent + per-host suppression meaningful) rather than
    // minting a doppelgänger at the anchor location.
    const email = body.email.toLowerCase().trim()
    const contactId = await findOrCreateRaceContact({
      db,
      locationId,
      email,
      name: body.name || 'Mailing list subscriber',
    })
    if (!contactId) {
      // Hard failure creating the contact — logged, but the public response
      // stays indistinguishable from success (no enumeration oracle).
      logError('host-list-subscribe', 'contact find-or-create failed', { slug: params.slug })
      return NextResponse.json({ success: true })
    }

    // Explicit opt-in — best-effort, same as the register route's consent
    // write (a consent-log hiccup must not fail the signup).
    try {
      await applyFormMarketingConsent(db, {
        contactId,
        consent: true,
        source: 'host_mailing_list',
        ipAddress: ip,
      })
    } catch (e) {
      logWarn('host-list-subscribe', 'marketing consent write error', { err: e })
    }

    // List membership — insert-once (re-subscribing is a no-op).
    const { error: memberErr } = await db
      .from('host_contacts')
      .upsert(
        { host_id: host.id, contact_id: contactId, source: 'mailing_list' },
        { onConflict: 'host_id,contact_id', ignoreDuplicates: true },
      )
    if (memberErr) {
      logError('host-list-subscribe', 'host_contacts upsert failed', { err: memberErr })
    }

    // Host tag in BOTH systems (memory: the two tag systems are separate —
    // targeting reads contacts.tags, segments/sequences read contact_tags).
    const tag = hostTagFor(host)
    try {
      // contacts.tags text[] — append-if-missing, the import-runner pattern.
      const { data: contactRow } = await db.from('contacts').select('tags').eq('id', contactId).maybeSingle()
      const prior = Array.isArray(contactRow?.tags) ? contactRow.tags : []
      if (!prior.includes(tag)) {
        await db.from('contacts').update({ tags: [...new Set([...prior, tag])] }).eq('id', contactId)
      }
    } catch (e) {
      logWarn('host-list-subscribe', 'contacts.tags append failed', { err: e })
    }
    try {
      // contact_tags — idempotent helper; fires tag_added sequences once.
      await writeContactTag(db, { contactId, locationId, tag })
    } catch (e) {
      logWarn('host-list-subscribe', 'contact_tags write failed', { err: e })
    }
  } catch (e) {
    logError('host-list-subscribe', 'subscribe flow failed', { err: e, slug: params.slug })
  }

  return NextResponse.json({ success: true })
}
