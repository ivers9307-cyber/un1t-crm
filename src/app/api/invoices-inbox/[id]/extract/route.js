// INVOICES.1 + INVOICEPREP.3 — "Read again".
//
// Rows are read and checked on arrival by the preparation queue
// (prepareInvoiceRow). This route is a person asking for a fresh read of one
// row, from received, quality_approved or extracted. It runs the same
// preparation as the queue, with force: a person who asks for a read gets one
// even when the file matches another row's file.
//
// Order of writes, each guarded on status so a concurrent action wins:
//   1. From extracted only: back to quality_approved, clearing the previous
//      read's reasons, duplicate link and error.
//   2. Claim the row (analysis_claimed_at, the queue's own claim), unless a
//      fresh claim says the queue is reading it right now. A claim older than
//      CLAIM_STALE_MINUTES is a crashed reader and is taken over.
//   3. prepareInvoiceRow downloads, reads, applies supplier memory and VAT,
//      records the reasons and clears the claim in its own guarded writes.
// If preparation throws, the claim taken here is let go, so the row is not
// left claimed until the stale window runs out.

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/with-auth'
import { logError } from '@/lib/log'
import { loadInvoiceForCaller, ROW_SELECT } from '../../_helpers'
import { prepareInvoiceRow } from '@/lib/invoices-queue/prepare'
import { CLAIM_STALE_MINUTES } from '@/lib/invoice-analysis-queue'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// A read of a long PDF can take a while.
export const maxDuration = 120

const READABLE = ['received', 'quality_approved', 'extracted']
const PREPARABLE = ['received', 'quality_approved']
const CONCURRENT = 'Row was modified concurrently — refresh and retry.'
const FAILED = 'Could not read the invoice. Try again.'

// withAuth only signs the caller in; loadInvoiceForCaller keeps the
// hand-written gate (row read, invoices_inbox and master-or-owner at the
// invoice's studio, every refusal a 404) exactly as the sibling routes run it.
export const POST = withAuth({ permission: null, location: false }, async ({ user: caller, params }) => {
  const id = params?.id
  const ctx = await loadInvoiceForCaller(caller, id)
  if (ctx.response) return ctx.response
  const { db, row } = ctx

  if (!READABLE.includes(row.status)) {
    return NextResponse.json({
      success: false,
      error: `Cannot extract from '${row.status}' state.`,
    }, { status: 409 })
  }
  if (!row.attachment_path) {
    return NextResponse.json({ success: false, error: 'Row has no attachment.' }, { status: 400 })
  }

  // 1. Preparation only reads rows that have not been read yet.
  if (row.status === 'extracted') {
    const { data: reset, error: resetErr } = await db
      .from('invoices_queue')
      .update({ status: 'quality_approved', review_reasons: [], duplicate_of_id: null, extraction_error: null })
      .eq('id', id)
      .eq('status', 'extracted')
      .select('id')
    if (resetErr) {
      logError('invoices-inbox', 'read again: reset failed', { invoiceId: id, err: resetErr })
      return NextResponse.json({ success: false, error: FAILED }, { status: 500 })
    }
    if (!reset || reset.length === 0) {
      return NextResponse.json({ success: false, error: CONCURRENT }, { status: 409 })
    }
  }

  // 2. Claim, so the queue cannot read the same row at the same time.
  const nowIso = new Date().toISOString()
  const staleBefore = new Date(Date.now() - CLAIM_STALE_MINUTES * 60_000).toISOString()
  const { data: claimed, error: claimErr } = await db
    .from('invoices_queue')
    .update({ analysis_claimed_at: nowIso, analysis_queued_at: nowIso })
    .eq('id', id)
    .in('status', PREPARABLE)
    .or(`analysis_claimed_at.is.null,analysis_claimed_at.lt.${staleBefore}`)
    .select('*')
  if (claimErr) {
    logError('invoices-inbox', 'read again: claim failed', { invoiceId: id, err: claimErr })
    return NextResponse.json({ success: false, error: FAILED }, { status: 500 })
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'This invoice is being read right now. Try again in a moment.',
    }, { status: 409 })
  }

  // 3. Preparation records its own outcome on the row.
  let outcome
  try {
    ;({ outcome } = await prepareInvoiceRow(db, claimed[0], { force: true }))
  } catch (err) {
    logError('invoices-inbox', 'read again: preparation threw', { invoiceId: id, err })
    const { error: releaseErr } = await db
      .from('invoices_queue')
      .update({ analysis_claimed_at: null, analysis_queued_at: null })
      .eq('id', id)
      .in('status', PREPARABLE)
    if (releaseErr) logError('invoices-inbox', 'read again: could not release the claim', { invoiceId: id, err: releaseErr })
    return NextResponse.json({ success: false, error: FAILED }, { status: 500 })
  }

  if (outcome === 'skipped') {
    return NextResponse.json({ success: false, error: CONCURRENT }, { status: 409 })
  }

  const { data: fresh, error: readErr } = await db
    .from('invoices_queue')
    .select(ROW_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (readErr) logError('invoices-inbox', 'read again: reload failed', { invoiceId: id, err: readErr })
  const data = readErr ? null : fresh

  // 422 is what the screen shows a retry for.
  if (outcome === 'unreadable') {
    return NextResponse.json({
      success: false,
      error: data?.extraction_error || 'Could not read this document.',
      data,
    }, { status: 422 })
  }
  return NextResponse.json({ success: true, data, outcome })
})
