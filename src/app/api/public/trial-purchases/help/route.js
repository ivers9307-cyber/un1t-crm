// POST /api/public/trial-purchases/help — TRIALSTUDIO.5: the "I need help"
// button on the /trial page. A Stillorgan buyer with a trial history, or a
// Hatch buyer with an active membership, is refused before paying and offered
// this instead. It files ONE trial_purchases row with status `help_requested`
// (a "Needs a call" card on the Approvals page) and alerts staff. No money is
// taken. A second press while a help row is open reuses it: no second card,
// no second alert. Two presses that interleave (both read "no open row") are
// settled by uniq_trial_purchases_open_help (mig 764): the second insert fails
// 23505 and is answered with the open row, also without an alert. No auth;
// rate-limited per studio and IP.
//
// PAGES.1 — `page` + `studio` (a public path): the studio's entry comes from
// the live page's studio row (trialEntryFromRow on the page's merged
// paid_trial block) and the help row records `page_id`; which eligibility
// read runs is the studio's membership_source. Without `page` the legacy
// studio key path (PR1; PR3 deletes it) is unchanged.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { isValidMobileNumber } from '@/lib/phone-validate'
import { studioByKey, loadTrialStudios, trialEntryFromRow } from '@/lib/trial-studios'
import { resolvePublicPageRequest, pageRequestRefusal } from '@/lib/landing-pages'
import { stillorganTrialHistory, hatchActiveMembership, reasonsText } from '@/lib/trial-eligibility'
import { alertTrialPurchaseStaff } from '@/lib/trial-purchase-processor'
import { logWarn, logError } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  // Without `page`, a TRIAL_STUDIOS key (required); with `page`, the studio's public path.
  studio: z.string().trim().max(40).optional(),
  page: z.string().trim().max(40).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine(isValidMobileNumber, 'Enter a valid mobile number'),
}).superRefine((v, ctx) => {
  if (!v.page && v.studio === undefined) ctx.addIssue({ code: 'custom', path: ['studio'], message: 'Required' })
})

const unavailable = () => NextResponse.json({ success: false, code: 'unavailable', error: 'We could not take your request right now. Please try again in a moment.' }, { status: 503 })

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  let entry
  let studioKey
  let isUn1t
  let pageId = null
  if (b.page) {
    // Resolved first, then limited on the resolved studio's key (the legacy
    // bucket for that studio); nothing resolved shares an 'unresolved' bucket.
    const r = await resolvePublicPageRequest(db, { hostname: request.headers.get('host'), page: b.page, studio: b.studio })
    const block = r.ok && r.page.offer_type === 'paid_trial'
      ? r.blocks.find((x) => x && typeof x === 'object' && x.type === 'paid_trial') || null
      : null
    if (r.ok && block) {
      try {
        entry = await trialEntryFromRow(db, { row: r.studioRow, publicPath: r.publicPath, mergedBlock: { ...block, ...r.attribution } })
      } catch (e) {
        logError('trialhelp', 'page studio entry unreadable', { pageId: r.pageId, locationId: r.locationId, errClass: e?.name })
        entry = { unreadable: true }
      }
    }
    studioKey = entry?.key || null
    const limit = await checkRateLimit(db, `trialhelp:${studioKey || 'unresolved'}:${ip}`, { max: 5, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a few minutes.')
    if (!r.ok || !block) {
      const refusal = pageRequestRefusal(r.ok ? 'not_found' : r.reason)
      return NextResponse.json(refusal.body, { status: refusal.status })
    }
    isUn1t = entry.membershipSource === 'un1t_online'
    pageId = r.pageId
  } else {
    // PR1 legacy (PR3 deletes it).
    const studio = studioByKey(b.studio)
    if (!studio) {
      return NextResponse.json({ success: false, code: 'unknown_studio', error: 'Unknown studio.' }, { status: 400 })
    }
    studioKey = studio.key
    isUn1t = studio.key !== 'stillorgan'

    const limit = await checkRateLimit(db, `trialhelp:${studio.key}:${ip}`, { max: 5, windowMs: 15 * 60_000 })
    if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a few minutes.')

    entry = (await loadTrialStudios(db)).find((s) => s.key === studio.key)
  }
  if (!entry || entry.unreadable) {
    logError('trialhelp', 'studio config unreadable', { studio: studioKey })
    return unavailable()
  }
  const config = entry.config
  if (!config || !entry.locationId) {
    return NextResponse.json({ success: false, code: 'not_configured', error: 'The trial is not available right now.' }, { status: 400 })
  }
  const locationId = entry.locationId

  const name = `${b.first_name} ${b.last_name}`.trim()
  const email = b.email.toLowerCase()
  const contactId = await findOrCreateRaceContact({
    db, locationId, email, name, phone: b.phone, restrictToOrg: true,
    insertFields: { source: 'paid_trial_help', first_name: b.first_name, last_name: b.last_name },
  })
  if (!contactId) {
    return NextResponse.json({ success: false, code: 'capture_failed', error: 'Could not capture your details. Please try again.' }, { status: 500 })
  }

  // Re-run the studio's eligibility read for the reasons the card will show.
  let reasons
  let reason
  if (!isUn1t) {
    reason = 'trial_used'
    const { data: contact, error: contactErr } = await db.from('contacts')
      .select('id, glofox_member_id, glofox_membership_status, glofox_membership_plan').eq('id', contactId).maybeSingle()
    if (contactErr || !contact) {
      logError('trialhelp', 'contact unreadable', { err: contactErr, contactId, locationId })
      return unavailable()
    }
    const history = await stillorganTrialHistory(db, { locationId, contact })
    if (!history.ok) return unavailable()
    reasons = history.reasons
  } else {
    reason = 'active_member'
    const membership = await hatchActiveMembership(db, { locationId, contactId })
    if (!membership.ok) return unavailable()
    reasons = membership.reasons
  }
  // The person asked for help: file the card even when the re-run finds nothing.
  if (!reasons.length) reasons = ['none_found']

  const sent = (purchaseId) => NextResponse.json({ success: true, data: { message: config.helpSentText, purchaseId } })

  const readOpen = () => db.from('trial_purchases')
    .select('id').eq('location_id', locationId).eq('contact_id', contactId).eq('status', 'help_requested').limit(1)
  const { data: open, error: openErr } = await readOpen()
  if (openErr) {
    logError('trialhelp', 'open help row unreadable', { code: openErr.code ?? null, contactId, locationId })
    return unavailable()
  }
  if (open?.[0]?.id) return sent(open[0].id)

  const { data: row, error: insErr } = await db.from('trial_purchases').insert({
    ...(pageId ? { page_id: pageId } : {}),
    location_id: locationId,
    contact_id: contactId,
    landing_path: entry.publicPath,
    customer_name: name,
    first_name: b.first_name,
    last_name: b.last_name,
    customer_email: email,
    customer_phone: b.phone,
    product_name: config.productName,
    un1t_product_id: config.un1tProductId || null,
    membership_id: config.membershipId || null,
    plan_code: config.planCode || null,
    amount_cents: config.priceCents,
    currency: config.currency,
    duration_days: config.durationDays,
    status: 'help_requested',
    // Glofox grants, it does not take payments: a Stillorgan help row has no
    // payment provider. A Hatch one names un1t.online, which would sell it.
    payment_provider: config.provider === 'un1t_online' ? 'un1t_online' : null,
    payment_status: null,
    last_error: reasonsText(reasons, reason),
  }).select('*').single()
  const insertFailed = () => NextResponse.json({ success: false, code: 'unavailable', error: 'Could not send your request. Please try again.' }, { status: 500 })
  // A double press that raced the read above: the other press filed the card.
  // Answer with its row, as the reuse path does (no second alert).
  if (insErr?.code === '23505') {
    const { data: again, error: againErr } = await readOpen()
    if (!againErr && again?.[0]?.id) return sent(again[0].id)
    logError('trialhelp', 'help row raced but the open row is unreadable', { code: againErr?.code ?? null, contactId, locationId })
    return insertFailed()
  }
  if (insErr || !row) {
    // Ids and the code only: a PostgREST error's details can name the row (email, phone).
    logError('trialhelp', 'help row insert failed', { code: insErr?.code ?? null, contactId, locationId })
    return insertFailed()
  }

  try {
    await alertTrialPurchaseStaff(db, row, reason, reasons.join(', '))
  } catch (e) {
    logWarn('trialhelp', 'staff alert failed', { purchaseId: row.id, err: e })
  }

  return sent(row.id)
}
