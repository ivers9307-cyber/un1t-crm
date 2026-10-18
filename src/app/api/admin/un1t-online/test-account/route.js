// POST /api/admin/un1t-online/test-account — UN1TWRITE.13.
//
// Master only. Drives the un1t.online write primitives (createClient,
// forgotPassword, grantTrial, book, cancel, createCheckoutLink) against ONE
// contact, the one named MIA TEST, for the controller's live verification
// run (plan D, "Live verification"). Every call is origin 'test_account' with
// the master as actor, and still passes every gate a real write passes: the
// writes switch, the token's studio and permissions, the budget, the ledger.
//
// Gates: getCurrentUser (401) → a master (403) → the body → the location and
// the contact, in the SAME organisation (404 otherwise: never confirm an id
// across tenants) → the contact's name is exactly "MIA TEST", any case (403).
// `create` also needs terms_confirmed: true (the master confirms MIA TEST's
// acceptance), recorded as terms_source 'test_account'.
//
// The answer carries the verdict, the code, un1t.online's (scrubbed) words,
// the ids and the ledger row. Never a password or un1t.online's create body
// (createClient hands back only the id); a checkout URL goes to the master in
// the answer and to no log line.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { Un1tSettingsReadError } from '@/lib/un1t-online-settings'
import { Un1tWriteRefused, Un1tWriteUnknown } from '@/lib/un1t-online-write'
import { createClient, forgotPassword, grantTrial, book, cancel, createCheckoutLink } from '@/lib/un1t-online-write-ops'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A write plus its check read can wait out one budget window.
export const maxDuration = 120

const LOG = 'un1t-test-account'
const TEST_NAME = 'mia test'
const bareId = z.string().trim().min(1).max(128).refine((v) => !/^un1t:/i.test(v), "Use the bare un1t.online id, without 'un1t:'")

const Body = z.object({
  op: z.enum(['create', 'forgot_password', 'trial', 'trial_skip_eligibility', 'book', 'cancel', 'checkout']),
  location_id: uuidLike,
  contact_id: uuidLike,
  event_id: bareId.optional(),
  booking_id: bareId.optional(),
  product_id: bareId.optional(),
  success_url: z.string().trim().url().max(500).optional(),
  cancel_url: z.string().trim().url().max(500).optional(),
  idempotency_key: z.string().trim().min(1).max(200).optional(),
  terms_confirmed: z.boolean().optional(),
})

const bad = (error, status = 400) => NextResponse.json({ success: false, error }, { status })
const ok = (data) => NextResponse.json({ success: true, data })
const writeAnswer = (r, extra = {}) => ok({
  verdict: r.verdict, code: r.code ?? null, message: r.message ?? null, ledger_id: r.ledgerId ?? null, ...extra,
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return bad('Unauthorized', 401)
  if (user.profileRole !== 'master') return bad('Only a master can use the un1t.online test account.', 403)

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const b = validation.data
  const db = createServerClient()
  const actor = { id: user.id }

  // `id` is the primary key on both reads.
  const { data: location, error: locErr } = await db.from('locations').select('id, organization_id').eq('id', b.location_id).maybeSingle()
  if (locErr) return bad('Could not read the studio. Try again.', 503)
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, organization_id, name, email, first_name, last_name, phone, un1t_user_id')
    .eq('id', b.contact_id)
    .maybeSingle()
  if (contactErr) return bad('Could not read the contact. Try again.', 503)
  if (!location || !contact || !contact.organization_id || contact.organization_id !== location.organization_id) return bad('Not found', 404)
  if (String(contact.name ?? '').trim().toLowerCase() !== TEST_NAME) {
    return bad('This route only acts on the contact named MIA TEST.', 403)
  }

  const needsAccount = b.op !== 'create'
  const un1tUserId = typeof contact.un1t_user_id === 'string' && contact.un1t_user_id.trim() ? contact.un1t_user_id.trim() : null
  if (needsAccount && !un1tUserId) return bad('MIA TEST has no un1t.online account linked yet. Run create first.')

  const base = { locationId: b.location_id, origin: 'test_account', actor }
  try {
    switch (b.op) {
      case 'create': {
        if (b.terms_confirmed !== true) return bad("Confirm that MIA TEST accepts un1t.online's terms and liability waiver (terms_confirmed: true).")
        // The legal documents' version is recorded by the funnel (plan D
        // PR 4); this route records the acceptance with no version.
        const r = await createClient(db, {
          ...base,
          contact: { id: contact.id, email: contact.email, name: contact.name, first_name: contact.first_name, last_name: contact.last_name, phone: contact.phone },
          terms: { acceptedAt: new Date().toISOString(), source: 'test_account', version: null },
        })
        return writeAnswer(r, { un1t_user_id: r.verdict === 'done' ? r.id ?? null : null, conflict: r.conflict ?? null })
      }
      case 'forgot_password': {
        const r = await forgotPassword(db, { ...base, contactId: contact.id, un1tUserId, email: contact.email })
        return writeAnswer(r)
      }
      case 'trial':
      case 'trial_skip_eligibility': {
        const r = await grantTrial(db, { ...base, contactId: contact.id, un1tUserId, skipEligibility: b.op === 'trial_skip_eligibility' })
        return ok({ outcome: r.outcome, method: r.method ?? null, reason: r.reason ?? null, code: r.code ?? null, message: r.message ?? null, ledger_id: r.ledgerId ?? null })
      }
      case 'book': {
        if (!b.event_id) return bad('event_id is required.')
        const r = await book(db, { ...base, contactId: contact.id, un1tUserId, eventId: b.event_id })
        return writeAnswer(r, { booking_id: r.verdict === 'done' ? r.id ?? null : null, already_booked: r.alreadyBooked === true })
      }
      case 'cancel': {
        if (!b.booking_id) return bad('booking_id is required.')
        const r = await cancel(db, { ...base, contactId: contact.id, un1tUserId, bookingId: b.booking_id })
        return writeAnswer(r, { booking_id: b.booking_id })
      }
      case 'checkout': {
        if (!b.product_id || !b.success_url || !b.cancel_url || !b.idempotency_key) {
          return bad('product_id, success_url, cancel_url and idempotency_key are required.')
        }
        // The ledger and idempotency key is namespaced to this route, studio
        // and contact, so a typed key can never adopt another client's open
        // checkout (the one-open index is global on the key).
        const r = await createCheckoutLink(db, {
          ...base, userId: un1tUserId, productId: b.product_id, successUrl: b.success_url, cancelUrl: b.cancel_url,
          idempotencyKey: `test_account:${b.location_id}:${contact.id}:${b.idempotency_key}`,
        })
        return ok({ verdict: 'done', checkout_url: r.checkoutUrl, free: r.free === true })
      }
      default:
        return bad('Unknown op.')
    }
  } catch (err) {
    if (err instanceof Un1tWriteRefused) return NextResponse.json({ success: false, code: err.code, error: err.message }, { status: 409 })
    if (err instanceof Un1tWriteUnknown) return NextResponse.json({ success: false, code: err.code, error: err.message, ledger_id: err.ledgerId ?? null }, { status: 502 })
    if (err instanceof Un1tSettingsReadError) return NextResponse.json({ success: false, code: err.code ?? 'settings_unreadable', error: 'Could not read the studio\'s un1t.online settings. Nothing was sent.' }, { status: 503 })
    // A TypeError here is a programming error inside a primitive, not a bad
    // request: logged (name and code only) and a 500.
    logError(LOG, 'test-account write failed', { op: b.op, code: err?.code ?? err?.name ?? 'error' })
    return NextResponse.json({ success: false, error: 'The write could not be completed. Check the ledger.' }, { status: 500 })
  }
}
