// src/components/invoices/review-status.js
// INVOICEPREP.3 — how today's Invoices screen shows the result of reading
// and checking an invoice on arrival. Pure: no React, no fetch.

import { REVIEW_REASONS, REVIEW_REASON_LABELS } from '@/lib/invoices-queue/readiness'

const RED_REASONS = new Set(['duplicate_file', 'duplicate_number', 'already_in_xero', 'credit_note', 'not_an_invoice', 'unreadable'])
const CHIP_STATUSES = new Set(['received', 'quality_approved', 'extracted', 'data_approved'])
const UNREAD_STATUSES = new Set(['received', 'quality_approved'])

function reasonsOf(row) {
  return Array.isArray(row?.review_reasons) ? row.review_reasons : []
}

/**
 * One chip per known reason (by label), or a green Ready chip for an
 * extracted row that was checked (prepared_at) and flagged nothing. A row
 * from before the checks has no prepared_at and gets no Ready.
 */
export function reasonChips(row) {
  if (!row || !CHIP_STATUSES.has(row.status)) return []
  const have = new Set(reasonsOf(row))
  const seen = new Set()
  const chips = []
  for (const key of REVIEW_REASONS) {
    if (!have.has(key)) continue
    const label = REVIEW_REASON_LABELS[key]
    if (seen.has(label)) continue
    seen.add(label)
    chips.push({ key, label, tone: RED_REASONS.has(key) ? 'red' : 'amber' })
  }
  if (chips.length === 0 && row.status === 'extracted' && row.prepared_at) {
    return [{ key: 'ready', label: 'Ready', tone: 'green' }]
  }
  return chips
}

/**
 * A row the bulk send would accept: read, coded and nothing flagged. It
 * does not ask for prepared_at, so an old row stays sendable as before.
 */
export function isReadyToSend(row) {
  if (!row) return false
  if (row.status !== 'extracted' && row.status !== 'data_approved') return false
  if (!row.extracted_fields) return false
  return reasonsOf(row).length === 0
}

/** Status pill additions; null keeps the component's own pill. */
export function pillFor(row) {
  if (!row) return null
  if (row.status === 'not_invoice') return { label: 'Not an invoice', tone: 'neutral' }
  if (UNREAD_STATUSES.has(row.status) && row.analysis_queued_at) return { label: 'Reading…', tone: 'blue' }
  return null
}

/** The sentence for a not_invoice_reason the reader decided. */
export function notInvoiceText(reason) {
  if (reason === 'document_type: statement') return 'This looks like a statement, not a bill'
  if (reason === 'document_type: other') return 'This does not look like an invoice'
  return null
}

/**
 * The panel for an unread row the reader gave up on, or null for a row
 * from before this change (today's quality panel then shows unchanged).
 */
export function unreadPanel(row) {
  if (!row || !UNREAD_STATUSES.has(row.status) || row.analysis_queued_at) return null
  const reasons = reasonsOf(row)
  if (reasons.includes('unreadable')) {
    return { title: 'This could not be read', primary: 'read_again', secondary: 'reject' }
  }
  if (reasons.includes('duplicate_file')) {
    return { title: 'This file is already in the queue', primary: 'reject', secondary: 'read_anyway' }
  }
  return null
}

/** How many rows a bulk send skipped because they need a look. */
export function needsALookSkipped(results) {
  if (!Array.isArray(results)) return 0
  return results.filter((r) => r?.outcome === 'skipped' && r?.reason === 'needs_a_look').length
}

/** A row queued to be read (shows "Reading…"). */
export function isBeingRead(row) {
  return pillFor(row)?.tone === 'blue'
}

/**
 * Whether the single-row reject (quality-reject) accepts this row: any
 * received row, or a quality_approved one the reader flagged unreadable
 * or as a duplicate file.
 */
export function canRejectOne(row) {
  if (!row) return false
  if (row.status === 'received') return true
  if (row.status !== 'quality_approved') return false
  const reasons = reasonsOf(row)
  return reasons.includes('unreadable') || reasons.includes('duplicate_file')
}

// INVSCREEN.1 — the Awaiting action list is split so repeated signature images
// and unreadable files do not bury the invoices.
const SET_ASIDE_REASONS = ['duplicate_file', 'unreadable']

/** A row the reader stopped on: a repeat of a file already queued, or a file it could not read. */
export function isSetAside(row) {
  if (!row || !UNREAD_STATUSES.has(row.status) || row.analysis_queued_at) return false
  const reasons = reasonsOf(row)
  return SET_ASIDE_REASONS.some((r) => reasons.includes(r))
}

/** A row that shows the green Ready chip. */
export function isReady(row) {
  return reasonChips(row).some((c) => c.key === 'ready')
}

export const PILES = Object.freeze([
  { key: 'review', label: 'To review' },
  { key: 'ready', label: 'Ready' },
  { key: 'aside', label: 'Duplicates and unreadable' },
])

/** Whether a row belongs in a pile. 'review' is everything not set aside; 'ready' is part of it. */
export function inPile(row, pile) {
  if (pile === 'aside') return isSetAside(row)
  if (pile === 'ready') return isReady(row)
  return !isSetAside(row)
}

/** How many rows each pile holds. */
export function pileCounts(rows) {
  const list = Array.isArray(rows) ? rows : []
  return {
    review: list.filter((r) => inPile(r, 'review')).length,
    ready: list.filter((r) => inPile(r, 'ready')).length,
    aside: list.filter((r) => inPile(r, 'aside')).length,
  }
}
