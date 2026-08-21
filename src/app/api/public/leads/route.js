// POST /api/public/leads — public waitlist / lead capture.
//
// Mirrors the /api/public/events lead_gen branch but with no event:
// capture name+email+phone+consent, create the contact at the studio
// (resolved server-side from public_path), record marketing consent,
// stamp the nurture tag, and open a new_lead deal so it shows in the
// pipeline. No auth; rate-limited (honeypot removed — browser autofill of
// the hidden field was silently dropping real signups; rate-limit suffices).

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { LeadSchema, normaliseLead, leadConfigFromBlocks, resolveCampaign } from '@/lib/leads'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const validation = await validateBody(request, LeadSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const { firstName, email, phone, publicPath, campaign } = normaliseLead(body)

  // SAAS-6: tenant-keyed (the landing public_path, resolved to a studio
  // just below) — one tenant's lead traffic can never consume another
  // tenant's window for the same IP. Runs after body validation (pure,
  // no DB) so the path is known; malformed bodies 400 without touching
  // the limiter.
  const limit = await checkRateLimit(db, `lead:${publicPath}:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes and try again.')
  }

  // Resolve the studio + its lead-form config from public_path. The
  // client never sends a location_id or the tag/source, so a caller
  // can't target an arbitrary location or inject arbitrary tags.
  const { data: page } = await db
    .from('landing_page_settings')
    .select('location_id, blocks')
    .eq('public_path', publicPath)
    .maybeSingle()
  if (!page || !page.location_id) {
    return NextResponse.json({ success: false, error: 'This studio is not accepting sign-ups right now.' }, { status: 400 })
  }
  const locationId = page.location_id
  let { tag, leadSource } = leadConfigFromBlocks(page.blocks)

  // Paid-traffic campaign override. Only applies when the slug is in
  // the server-side allowlist AND its studio matches the resolved
  // public_path — so a campaign can't be replayed against another
  // studio or used to inject an arbitrary tag/source.
  const camp = resolveCampaign(campaign)
  if (camp && camp.locationPublicPath === publicPath) {
    tag = camp.tag
    leadSource = camp.leadSource
  }

  // Find-or-create the contact at this studio (shared public-form helper).
  // restrictToOrg (LEADCAP.1): match here first, then sibling locations in the
  // same organisation, never globally. restrictToLocation used to be the flag,
  // but `contacts_email_unique` is a GLOBAL index — so an existing Stillorgan
  // member joining the Hatch Street waitlist found no match, hit 23505 on the
  // insert, and got a 500. Org scope keeps the cross-TENANT IDOR closed.
  const contactId = await findOrCreateRaceContact({ db, locationId, email, name: firstName, phone, restrictToOrg: true })
  if (!contactId) {
    return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
  }

  // Stamp lead_source only when the contact has none yet (don't clobber
  // a richer existing attribution). Best-effort.
  try {
    await db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null)
    // FUNNEL.5 — LAST-touch alongside the first-touch stamp above, so a
    // contact re-entering through the website records what brought them back.
    await db.from('contacts')
      .update({ last_lead_source: leadSource, last_lead_source_at: new Date().toISOString() })
      .eq('id', contactId)
  } catch (e) { logWarn('leads', 'lead_source set failed', { err: e }) }

  // CAPI: paid-funnel website Lead event. Contact-keyed event_id so repeat
  // submits dedupe at Meta; dataset gating lives in the helper.
  try {
    const { sendWebsiteConversion } = await import('@/lib/meta-capi')
    await sendWebsiteConversion(db, {
      locationId, eventName: 'Lead', email, phone,
      eventSourceUrl: camp && camp.locationPublicPath === publicPath
        ? 'https://www.un1tdublin.com/free-class'
        : `https://www.un1tdublin.com/${publicPath}`,
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

  // Open a new_lead deal so the lead shows in the pipeline. Direct +
  // deterministic (a brand-new web lead is unambiguously new_lead);
  // skip when the contact already has an open deal. Best-effort.
  try {
    const { data: openDeal } = await db.from('deals').select('id').eq('contact_id', contactId).eq('status', 'open').maybeSingle()
    if (!openDeal) {
      const { data: stage } = await db.from('pipeline_stages').select('id').eq('location_id', locationId).eq('slug', 'new_lead').maybeSingle()
      if (stage) {
        await db.from('deals').insert({ title: firstName || 'Website lead', contact_id: contactId, stage_id: stage.id, location_id: locationId, status: 'open' })
      }
    }
  } catch (e) { logWarn('leads', 'deal create failed', { err: e }) }

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
      await triggerSequencesForContactCreated(contactRow.id)
    }
  } catch (e) { logWarn('leads', 'glofox provisioning hook failed', { err: e }) }

  // Campaign first-touch WhatsApp (e.g. Meta free-class lead → welcome
  // template w/ quick-reply buttons → Mia handoff). Only fires for
  // campaigns that configure a template; best-effort, never blocks.
  try {
    const camp = resolveCampaign(campaign)
    if (camp?.whatsappTemplate) {
      const { data: c } = await db
        .from('contacts')
        .select('id, name, first_name, phone, wa_phone')
        .eq('id', contactId)
        .maybeSingle()
      if (c) {
        const { maybeSendCampaignWhatsappWelcome } = await import('@/lib/automations/meta-ad-whatsapp-welcome')
        await maybeSendCampaignWhatsappWelcome({ db, locationId, contact: c, templateName: camp.whatsappTemplate })
      }
    }
  } catch (e) { logWarn('leads', 'campaign WA welcome failed', { err: e }) }

  return NextResponse.json({ success: true, data: { already_on_list: alreadyOnList } })
}
