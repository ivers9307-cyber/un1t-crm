// POST /api/public/class-booking — public enqueue for the /start wizard's class
// path. Captures the lead in the CRM (contact + new_lead deal + lead_source +
// tag = "reclassify as a fresh lead") then enqueues a class_booking_requests
// row for the process-class-bookings cron. Returns instantly; the booking +
// WhatsApp confirmation happen async. No auth; rate-limited.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  event_id: z.string().trim().min(1).max(64),
  class_name: z.string().trim().max(200).optional(),
  starts_at: z.string().trim().max(40).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine(isValidMobileNumber, 'Enter a valid mobile number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick consent to continue' }),
})

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `classbook:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  const { data: page } = await db.from('landing_page_settings')
    .select('location_id').eq('public_path', 'stillorgan').maybeSingle()
  if (!page?.location_id) {
    return NextResponse.json({ success: false, error: 'Class booking is not available right now.' }, { status: 400 })
  }
  const locationId = page.location_id
  const name = `${b.first_name} ${b.last_name}`.trim()

  // Validate the chosen class against the live bookable list — never trust the
  // client's event_id / class_name / starts_at. We use the SERVER's name + start
  // for storage so spoofed text can't reach Glofox, /approvals or the WhatsApp
  // confirmation, and an event_id not in the list is rejected (don't capture a
  // lead for a class that can't be booked).
  const { listPublicClasses } = await import('@/lib/public-classes')
  let chosen = null
  try {
    const classes = await listPublicClasses(db, locationId, 14)
    chosen = classes.find((c) => c.event_id === b.event_id) || null
  } catch (e) { logWarn('classbook', 'class validate failed', { err: e }) }
  if (!chosen) {
    return NextResponse.json({ success: false, error: 'That class is no longer available — please pick another.' }, { status: 400 })
  }

  // restrictToLocation: a public form must not resolve (and then enqueue a Glofox
  // booking / write consent against) an existing contact at another location.
  const contactId = await findOrCreateRaceContact({ db, locationId, email: b.email.toLowerCase(), name, phone: b.phone, restrictToLocation: true })
  if (!contactId) return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })

  try { await db.from('contacts').update({ lead_source: 'meta_book' }).eq('id', contactId).is('lead_source', null) } catch (e) { logWarn('classbook', 'lead_source failed', { err: e }) }
  try { await writeContactTag(db, { contactId, locationId, tag: 'stillorgan-start' }) } catch (e) { logWarn('classbook', 'tag failed', { err: e }) }
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'start_class', ipAddress: ip })
  } catch (e) { logWarn('classbook', 'consent failed', { err: e }) }
  try {
    const { data: openDeal } = await db.from('deals').select('id').eq('contact_id', contactId).eq('status', 'open').maybeSingle()
    if (!openDeal) {
      const { data: stage } = await db.from('pipeline_stages').select('id').eq('location_id', locationId).eq('slug', 'new_lead').maybeSingle()
      if (stage) await db.from('deals').insert({ title: b.first_name || 'Class lead', contact_id: contactId, stage_id: stage.id, location_id: locationId, status: 'open' })
    }
  } catch (e) { logWarn('classbook', 'deal failed', { err: e }) }

  // Dedupe: if this contact already has an active/booked request for this class
  // (double-submit, refresh, retry), don't create a second. Treat as success.
  try {
    const { data: existing } = await db.from('class_booking_requests')
      .select('id').eq('contact_id', contactId).eq('glofox_event_id', b.event_id)
      .in('status', ['queued', 'processing', 'booked']).limit(1).maybeSingle()
    if (existing) return NextResponse.json({ success: true, data: { queued: true, deduped: true } })
  } catch (e) { logWarn('classbook', 'dedupe check failed', { err: e }) }

  // class_name + starts_at come from the SERVER-validated class, not the client.
  const { error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: chosen.name,
    starts_at: chosen.starts_at,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    status: 'queued',
  })
  if (insErr) {
    // A unique-violation (23505) means a concurrent request won the race for the
    // same (contact, class) — that's a successful dedupe, not an error.
    if (insErr.code === '23505') return NextResponse.json({ success: true, data: { queued: true, deduped: true } })
    logWarn('classbook', 'enqueue failed', { err: insErr })
    return NextResponse.json({ success: false, error: 'Could not start your booking. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { queued: true } })
}
