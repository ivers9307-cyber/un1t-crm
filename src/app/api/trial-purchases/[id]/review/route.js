// POST /api/trial-purchases/[id]/review — resolve a paid trial purchase
// whose Glofox grant needs a hand (PAIDTRIAL.2).
//
//   { action: 'retry' }   put the row back in the queue; the worker (or the
//                         2-minute sweeper) runs the processor again. The
//                         write-ahead grant marker is KEPT, so a purchase
//                         Glofox never answered is still never bought twice:
//                         such a row comes straight back as grant_unverified
//                         and wants `resolve` once staff have checked Glofox.
//   { action: 'resolve' } staff put the plan on the account by hand in
//                         Glofox: the row is granted (manual), the buyer gets
//                         the confirmation email.
//   { action: 'handled' } a help_requested row (nobody paid; the buyer asked
//                         for a call): staff rang them, the row is closed.
//                         No email.
//
// Gated on approvals_offer_purchases (the same people who fulfil paid sale
// offers), judged at the purchase's studio. Detail-route semantics: an id
// outside the caller's studios answers 404, not 403.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { createServerClient } from '@/lib/supabase'
import { publishQueuePush, TRIAL_PURCHASES_WORKER_PATH } from '@/lib/qstash'
import { sendTrialPurchaseEmail } from '@/lib/trial-purchase-emails'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const bodySchema = z.object({ action: z.enum(['retry', 'resolve', 'handled']) })

// retry/resolve act on a paid row the grant stalled on; handled acts on a help row.
const REVIEWABLE = new Set(['needs_review', 'failed'])

export async function POST(request, props) {
  const { id } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'approvals_offer_purchases')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const validation = await validateBody(request, bodySchema)
  if (!validation.ok) return validation.response
  const { action } = validation.data

  const db = createServerClient()
  const { data: row, error: readErr } = await db
    .from('trial_purchases')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (readErr) return NextResponse.json({ success: false, error: 'read_failed' }, { status: 503 })
  if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, row.location_id)
  if (guard) return guard
  if (!hasPermissionForLocation(user, row.location_id, 'approvals_offer_purchases')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (action === 'handled') {
    if (row.status === 'handled') {
      return NextResponse.json({ success: true, data: { already: true, status: 'handled' } })
    }
    if (row.status !== 'help_requested') {
      return NextResponse.json({ success: false, error: 'in_progress', status: row.status }, { status: 409 })
    }
    const { data: upd, error } = await db
      .from('trial_purchases')
      .update({ status: 'handled', last_error: null })
      .eq('id', id)
      .eq('status', 'help_requested')
      .select('id')
    if (error) return NextResponse.json({ success: false, error: 'write_failed' }, { status: 500 })
    if (!upd || upd.length === 0) return NextResponse.json({ success: false, error: 'in_progress' }, { status: 409 })
    return NextResponse.json({ success: true, data: { status: 'handled' } })
  }
  if (row.payment_status !== 'paid') {
    return NextResponse.json({ success: false, error: 'not_paid' }, { status: 409 })
  }
  if (row.status === 'granted') {
    return NextResponse.json({ success: true, data: { already: true, status: 'granted' } })
  }
  if (!REVIEWABLE.has(row.status)) {
    // queued / processing: the processor holds it; nothing to do by hand.
    return NextResponse.json({ success: false, error: 'in_progress', status: row.status }, { status: 409 })
  }

  const now = new Date().toISOString()
  if (action === 'retry') {
    const { data: upd, error } = await db
      .from('trial_purchases')
      .update({ status: 'queued', attempts: 0, last_error: null })
      .eq('id', id)
      .eq('status', row.status)
      .select('id')
    if (error) return NextResponse.json({ success: false, error: 'write_failed' }, { status: 500 })
    if (!upd || upd.length === 0) return NextResponse.json({ success: false, error: 'in_progress' }, { status: 409 })
    // Best-effort nudge; the 2-minute sweeper is the guarantee.
    try { await publishQueuePush({ path: TRIAL_PURCHASES_WORKER_PATH, body: { id }, deduplicationId: `trial-purchase-retry-${id}-${Date.now()}` }) } catch { /* sweeper */ }
    return NextResponse.json({ success: true, data: { status: 'queued' } })
  }

  // resolve
  const grant = { ...(row.grant && typeof row.grant === 'object' ? row.grant : {}), ok: true, manual: true, by: user.id, at: now }
  const { data: upd, error } = await db
    .from('trial_purchases')
    .update({ status: 'granted', granted_at: now, grant, last_error: null })
    .eq('id', id)
    .eq('status', row.status)
    .select('id')
  if (error) return NextResponse.json({ success: false, error: 'write_failed' }, { status: 500 })
  if (!upd || upd.length === 0) return NextResponse.json({ success: false, error: 'in_progress' }, { status: 409 })

  let emailed = false
  try {
    const r = await sendTrialPurchaseEmail(db, { purchase: { ...row, status: 'granted', granted_at: now }, kind: 'granted' })
    emailed = r?.status === 'sent'
  } catch (e) {
    logWarn('trial-purchase-review', `confirmation email failed for ${id}`, { err: e })
  }
  return NextResponse.json({ success: true, data: { status: 'granted', emailed } })
}
