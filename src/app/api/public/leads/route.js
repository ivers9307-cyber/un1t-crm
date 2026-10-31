// POST /api/public/leads — public waitlist / lead capture.
//
// Mirrors the /api/public/events lead_gen branch but with no event:
// capture name+email+phone+consent, create the contact at the studio
// (resolved server-side from public_path), record marketing consent,
// stamp the nurture tag, and open a new_lead deal so it shows in the
// pipeline. No auth; rate-limited (honeypot removed — browser autofill of
// the hidden field was silently dropping real signups; rate-limit suffices).
//
// PAGES.1 — `page` + `studio` (studio optional on a one-studio page): the
// studio is the live page's resolved studio row, and the tag and lead source
// are the page's lead_form block's own when it sets them (a lead form is a
// content block), else the row's attribution; the CAPI eventSourceUrl is the
// row's, else the page's URL. `public_path` is ignored and the body can never
// set a tag or source. Without `page`, `public_path` names a STUDIO PAGE by its
// slug (/stillorgan's own lead form): the studio page's lead_form block carries
// the tag and lead source (leadConfigFromBlocks). The paid-traffic campaign key
// and its WhatsApp welcome are gone: a campaign is a page of its own now.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { LeadSchema, normaliseLead, leadConfigFromBlocks } from '@/lib/leads'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { stampLeadSource } from '@/lib/lead-source-stamp'
import { sanitiseVisitOrigin } from '@/lib/visit-origin'
import { writeContactTag } from '@/lib/contact-tags'
import { logWarn } from '@/lib/log'
import { placeWaitlistEntry } from '@/lib/waitlist-entry'
import { resolvePublicPageRequest, pageRequestRefusal } from '@/lib/landing-pages'

export const runtime = 'nodejs'

// LeadSchema with the page form: `public_path` is required only without `page`.
const RouteLeadSchema = LeadSchema.extend({
  public_path: z.string().trim().min(1).max(120).optional(),
  page: z.string().trim().max(40).optional(),
  studio: z.string().trim().max(40).optional(),
}).superRefine((v, ctx) => {
  if (!v.page && !v.public_path) ctx.addIssue({ code: 'custom', path: ['public_path'], message: 'Required' })
})

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null)

// PAGES.1 — the studio and attribution of a resolved page request.
function pageLeadConfig(r) {
  const lf = (Array.isArray(r.blocks) ? r.blocks : []).find((b) => b && typeof b === 'object' && b.type === 'lead_form')
  return {
    locationId: r.locationId,
    tag: str(lf?.tag) || r.attribution.tag,
    leadSource: str(lf?.lead_source) || r.attribution.lead_source,
    eventSourceUrl: str(r.attribution.event_source_url) || `https://www.un1tdublin.com/${r.page.slug}`,
  }
}

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const validation = await validateBody(request, RouteLeadSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const normalised = normaliseLead({ ...body, public_path: body.public_path ?? '' })
  const { firstName, email, phone, visit } = normalised
  let locationId
  let tag
  let leadSource
  let eventSourceUrl
  if (body.page) {
    // Resolved first, then limited on the RESOLVED studio path (the legacy
    // key for that studio); nothing resolved shares an 'unresolved' bucket.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), page: body.page, studio: body.studio })
    const limit = await checkRateLimit(db, `lead:${r.ok ? r.publicPath : 'unresolved'}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) {
      return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes and try again.')
    }
    if (!r.ok) {
      const refusal = pageRequestRefusal(r.reason)
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    ;({ locationId, tag, leadSource, eventSourceUrl } = pageLeadConfig(r))
  } else {
    const { publicPath } = normalised

    // SAAS-6: tenant-keyed (the landing public_path, resolved to a studio
    // just below) — one tenant's lead traffic can never consume another
    // tenant's window for the same IP. Runs after body validation (pure,
    // no DB) so the path is known; malformed bodies 400 without touching
    // the limiter.
    const limit = await checkRateLimit(db, `lead:${publicPath}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
    if (!limit.allowed) {
      return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes and try again.')
    }

    // Resolve the studio + its lead-form config from the studio page the
    // public_path names. The client never sends a location_id or the
    // tag/source, so a caller can't target an arbitrary location or inject
    // arbitrary tags. A failed read is 503, never "not accepting sign-ups".
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), legacyPath: publicPath })
    if (!r.ok && r.reason === 'unreadable') {
      const refusal = pageRequestRefusal('unreadable')
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    if (!r.ok) {
      return NextResponse.json({ success: false, error: 'This studio is not accepting sign-ups right now.' }, { status: 400 })
    }
    locationId = r.locationId
    ;({ tag, leadSource } = leadConfigFromBlocks(r.blocks))
    eventSourceUrl = `https://www.un1tdublin.com/${publicPath}`
  }

  // Find-or-create the contact at this studio (shared public-form helper).
  // restrictToOrg (LEADCAP.1): match here first, then sibling locations in the
  // same organisation, never globally. restrictToLocation used to be the flag,
  // but under mig 008's GLOBAL `contacts_email_unique` an existing Stillorgan
  // member joining the Hatch Street waitlist found no match, hit 23505 on the
  // insert, and got a 500. Org scope keeps the cross-TENANT IDOR closed; since
  // W0.6 (mig 712, unique per organisation) it is also the helper's default.
  // SOURCE-LABEL.1 — see class-booking: a website lead form is not a race
  // signup. CREATE only; matched contacts are untouched.
  const contactId = await findOrCreateRaceContact({ db, locationId, email, name: firstName, phone, restrictToOrg: true, insertFields: { source: 'lead_form' } })
  if (!contactId) {
    return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
  }

  // Stamp lead_source only when the contact has none yet (don't clobber
  // a richer existing attribution). FUNNEL.5 — LAST-touch alongside it, so a
  // contact re-entering through the website records what brought them back;
  // ORGCONTACTS.4 — only when this studio is the contact's primary (at a
  // sibling studio the lead_form contact_studios row is the record). Best-effort.
  try {
    await stampLeadSource(db, { contactId, locationId, leadSource })
  } catch (e) { logWarn('leads', 'lead_source set failed', { err: e }) }
  // VISIT-ORIGIN.1 — first touch, stamp-if-null, best-effort.
  try {
    const v = sanitiseVisitOrigin(visit)
    if (v) {
      await db.from('contacts')
        .update({ visit_referrer: v.referrer, visit_landing_path: v.landing_path, visit_captured_at: new Date().toISOString() })
        .eq('id', contactId)
        .is('visit_captured_at', null)
    }
  } catch (e) { logWarn('leads', 'visit origin failed', { err: e }) }

  // CAPI: paid-funnel website Lead event. Contact-keyed event_id so repeat
  // submits dedupe at Meta; dataset gating lives in the helper.
  try {
    const { sendWebsiteConversion } = await import('@/lib/meta-capi')
    await sendWebsiteConversion(db, {
      locationId, eventName: 'Lead', email, phone,
      eventSourceUrl,
      eventId: `weblead-${contactId}`,
      contentName: leadSource || 'website_lead',
    })
  } catch (e) { logWarn('leads', 'capi lead failed', { err: e }) }

  // Marketing consent (best-effort; helper short-circuits ClassPass).
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'waitlist_form', ipAddress: ip, locationId })
  } catch (e) { logWarn('leads', 'consent write failed', { err: e }) }

  // Nurture-seam tag (idempotent; fires tag_added sequences exactly once).
  let alreadyOnList = false
  try {
    const r = await writeContactTag(db, { contactId, locationId, tag })
    alreadyOnList = !!r.alreadyPresent
  } catch (e) { logWarn('leads', 'tag write failed', { err: e }) }

  // Open (or re-open) this lead's place on the studio's primary board so they
  // show in the pipeline. Best-effort — losing the deal must never cost the
  // lead capture, so the helper swallows its own failures and this try/catch is
  // the belt to its braces. The reasoning for each line of the placement, and
  // for the manual-board re-signup bump, lives in the helper (WAITLIST.4).
  try {
    await placeWaitlistEntry(db, {
      contactId,
      locationId,
      title: firstName || 'Website lead',
    })
  } catch (e) { logWarn('leads', 'deal placement failed', { err: e }) }

  // AUTOMATIONS: glofox_lead_provisioning (website lead path).
  try {
    const { data: contactRow } = await db
      .from('contacts')
      .select('id, name, email, first_name, last_name, phone, source, lead_source, glofox_member_id, location_id')
      .eq('id', contactId)
      .maybeSingle()
    if (contactRow) {
      const { maybeProvisionLeadInGlofox } = await import('@/lib/automations/glofox-lead-provisioning')
      await maybeProvisionLeadInGlofox({ db, locationId, contact: contactRow, source: 'website_lead' })
      const { triggerSequencesForContactCreated } = await import('@/lib/sequences/triggers')
      // SHAREDCONTACT.1 — the form's studio, not the contact's home: a
      // Stillorgan member joining Hatch Street's list is new to Hatch.
      await triggerSequencesForContactCreated(contactRow.id, { locationId })
    }
  } catch (e) { logWarn('leads', 'glofox provisioning hook failed', { err: e }) }

  return NextResponse.json({ success: true, data: { already_on_list: alreadyOnList } })
}
