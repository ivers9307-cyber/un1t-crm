// SPEND.P3 — company-card receipt helpers.
//
// Pure path + validation helpers for the company-card receipts feature
// (mig 266). The receipt file (PDF or photo) lives in the private
// 'company-card-receipts' storage bucket; these build + validate the
// per-submitter storage path the same way contractor invoices do.
//
// The receipt MIME machinery (accepted types + magic-byte sniff) is
// shared with contractor invoices (SPEND.P1) — re-exported here so the
// card-receipt routes import everything receipt-related from one place.

import {
  RECEIPT_MIME_TYPES,
  sniffReceiptMime,
  mimeFromFilename,
} from './contractor-invoices'

export { RECEIPT_MIME_TYPES, sniffReceiptMime, mimeFromFilename }

export const CARD_RECEIPTS_BUCKET = 'company-card-receipts'
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024 // 10 MB — keep in lockstep with the routes

/**
 * Build the storage path for a company-card receipt. Folder structure
 * (submitter → date) means an operator browsing the bucket can find a
 * person's receipts. A short random suffix avoids collisions when the
 * same person submits two receipts on the same purchase date.
 */
export function buildReceiptPath({ submitterId, purchaseDate, originalFilename }) {
  const safeName = String(originalFilename || 'receipt')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100)
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${submitterId}/${purchaseDate}-${suffix}-${safeName}`
}

/**
 * True when `path` is a company-card-receipt storage key owned by
 * `submitterId` — i.e. shaped like buildReceiptPath's output and inside
 * that submitter's own folder. The finalise route accepts a
 * client-supplied receipt_path (minted by /api/card-receipts/upload-sign),
 * so it must refuse paths pointing at other people's objects or anywhere
 * else in the bucket.
 */
export function isCardReceiptPath(path, submitterId) {
  const s = String(path || '')
  if (!submitterId || !s.startsWith(`${submitterId}/`)) return false
  return /^[0-9a-fA-F-]{32,36}\/[A-Za-z0-9._-]{1,160}$/.test(s)
}
