// POST /api/public/host-list/[slug]/subscribe
//
// Public mailing-list signup for an event host's list (HOST-EMAIL.2). No
// auth — same posture as /api/public/races/[slug]/register: per-IP rate
// limit + Zod body + slug lookup (404 on unknown slug; slugs are public).
//
// Flow: find-or-create the contact at the org's MASTER location (HOST-MASTER.4
// — Stillorgan for UN1T Group, so host signups land next to the real member
// base; the host's lazily-provisioned anchor location is only the fallback
// when no master is configured), stamping automations_exempt on CREATE only
// (matched existing contacts keep their settings), apply marketing consent
// TRUE (this form IS the
// explicit opt-in — same applyFormMarketingConsent the event register route
// uses: contact_preferences three channels + consent_log + email_status
// mirror), upsert host_contacts membership (source='mailing_list',
// insert-once), and tag the contact with the host tag in BOTH systems —
// contacts.tags text[] (import-style append-if-missing) AND contact_tags
// (writeContactTag: idempotent + fires tag_added sequences).
//
// HOST-CONSENT.1 — the signup grants BOTH consents, and they never cross:
// the UN1T marketing consent above (contact_preferences / email_status, as
// before) AND the host's OWN list consent (host_contacts.marketing_consent,
// its own consent_log channel — see src/lib/host-consent.js). If this
// contact previously unsubscribed from THIS host (a row in
// host_email_suppressions), signing up again is a re-subscribe: the
// suppression is dropped, host consent is re-granted (source
// 'host_resubscribe'), and only OUR OWN ManualSuppression is lifted on the
// host's Postmark stream (never a bounce or complaint suppression).
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
import { ensureAnchorLocation, resolveMasterLocationId } from '@/lib/host-events'
import { hostTagFor } from '@/lib/host-contact-list'
import { writeContactTag } from '@/lib/contact-tags'
import { applyFormMarketingConsent } from '@/lib/marketing-consent'
import { grantHostConsent, resubscribeHost } from '@/lib/host-consent'
import { unsuppressAtPostmark } from '@/lib/postmark-suppressions'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

const SubscribeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320),
})

export async function POST(request, props) {
  const params = await props.params
  const db = createServerClient()

  // Same limiter class as the public register route (5 per IP / 15 min).
  // SAAS-6: tenant-keyed (the host slug) — one host's signup traffic
  // can never consume another host's window for the same IP.
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `host-list:${params.slug}:${ip}`, { max: 5, windowMs: 15 * 60_000 })
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
    .select('id, name, slug, organization_id, anchor_location_id, postmark_stream_id')
    .eq('slug', params.slug)
    .maybeSingle()
  if (!host) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  try {
    // HOST-MASTER.4 — contacts live at the org's master location so a signup
    // from an existing member matches their REAL contact row; the anchor
    // location is only the fallback when no master is configured.
    const locationId = await resolveMasterLocationId(db, host) || host.anchor_location_id || await ensureAnchorLocation(db, host)

    const email = body.email.toLowerCase().trim()
    // restrictToLocation — match is scoped to ONE location (never a global
    // email resolve). Since HOST-MASTER.4 that location is the org MASTER, so
    // a signup with a known member's email deliberately links to their real
    // contact and re-affirms marketing consent — that's the feature, and the
    // accepted posture of every public opt-in form (/api/public/leads,
    // class-booking). The tenant-keyed rate limit + always-identical response
    // bound the abuse surface: no enumeration oracle, no bulk probing.
    const contactId = await findOrCreateRaceContact({
      db,
      locationId,
      email,
      name: body.name,
      restrictToLocation: true,          // match at the MASTER location = link to the real member
      insertFields: { automations_exempt: true },  // new contacts only — matches keep their settings
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
    } else {
      // HOST-CONSENT.1 — the HOST consent, independent of the UN1T one above.
      // A contact who previously unsubscribed from THIS host and signs up
      // again is resubscribing: drop the suppression, grant, and lift only
      // our own ManualSuppression on the host's Postmark stream (never a
      // bounce or complaint — unsuppressAtPostmark reads the reason first).
      const { data: existingSup, error: supErr } = await db
        .from('host_email_suppressions')
        .select('id')
        .eq('host_id', host.id)
        .eq('contact_id', contactId)
        .maybeSingle()
      if (supErr) logWarn('host-list-subscribe', 'suppression lookup failed', { err: supErr })
      const consentResult = existingSup
        ? await resubscribeHost(db, { hostId: host.id, contactId, ipAddress: ip })
        : await grantHostConsent(db, { hostId: host.id, contactId, source: 'mailing_list_form', ipAddress: ip })
      if (!consentResult.ok) {
        logError('host-list-subscribe', 'host consent write failed', { err: consentResult.error, host_id: host.id })
      }
      if (existingSup && host.postmark_stream_id) {
        try {
          const lift = await unsuppressAtPostmark(email, { stream: host.postmark_stream_id })
          if (lift?.failed?.length) logWarn('host-list-subscribe', 'Postmark host-stream lift failed', { message: lift.failed[0]?.message })
        } catch (e) {
          logWarn('host-list-subscribe', 'Postmark host-stream lift threw', { err: e?.message || String(e) })
        }
      }
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
