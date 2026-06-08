// POST /api/public/leads — public waitlist / lead capture.
//
// Mirrors the /api/public/events lead_gen branch but with no event:
// capture name+email+phone+consent, create the contact at the studio
// (resolved server-side from public_path), record marketing consent,
// stamp the nurture tag, and open a new_lead deal so it shows in the
// pipeline. No auth; rate-limited + honeypot like the other public forms.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { LeadSchema, normaliseLead, leadConfigFromBlocks } from '@/lib/leads'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const limit = await checkRateLimit(db, `lead:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes and try again.')
  }

  const validation = await validateBody(request, LeadSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Honeypot — bots fill `company`; humans never see it. Pretend success
  // so the bot gets no signal, but write nothing.
  if (body.company && body.company.trim().length > 0) {
    return NextResponse.json({ success: true, data: { already_on_list: false } })
  }

  const { firstName, email, phone, publicPath } = normaliseLead(body)

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
  const { tag, leadSource } = leadConfigFromBlocks(page.blocks)

  // Find-or-create the contact at this studio (shared public-form helper).
  const contactId = await findOrCreateRaceContact({ db, locationId, email, name: firstName, phone })
  if (!contactId) {
    return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })
  }

  // Stamp lead_source only when the contact has none yet (don't clobber
  // a richer existing attribution). Best-effort.
  try {
    await db.from('contacts').update({ lead_source: leadSource }).eq('id', contactId).is('lead_source', null)
  } catch (e) { logWarn('leads', 'lead_source set failed', { err: e }) }

  // Marketing consent (best-effort; helper short-circuits ClassPass).
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'waitlist_form', ipAddress: ip })
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

  return NextResponse.json({ success: true, data: { already_on_list: alreadyOnList } })
}
