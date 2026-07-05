// src/lib/recon/manual-upload.js
//
// RCOV.P2 — pure helpers behind the per-bank-line "Upload receipt"
// action. The route stays thin; the hash/sanitize/dedupe-decision
// logic lives here where it's unit-testable. The content hash is the
// same cross-source duplicate guard used by the hunt intake (a
// document uploaded manually AND found by the hunt/email/card paths
// must never become two Xero bills).
import { createHash } from 'crypto'

export function prepareManualUpload({ bytes, filename }) {
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const safeName = String(filename || 'receipt')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(-80) || 'receipt'
  return { contentHash, safeName }
}

// Look up an existing queue row carrying this content hash (any
// source). Returns { existingId } or { existingId: null }; throws on
// query error.
export async function findQueueRowByHash(db, contentHash) {
  const { data, error } = await db
    .from('invoices_queue')
    .select('id')
    .eq('content_hash', contentHash)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`manual-upload hash lookup failed: ${error.message}`)
  return { existingId: data?.id || null }
}
