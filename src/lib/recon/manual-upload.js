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
// source) AT THIS STUDIO. Returns { existingId } or { existingId: null };
// throws on query error.
//
// FINSCOPE.1 (audit 2026-11-15, area 15): the lookup was not scoped to a
// studio, so a file identical to one in another studio's (or another
// organisation's) queue linked this studio's bank line to that row and
// this studio got no bill. A studio's documents only ever dedupe against
// its own queue.
export async function findQueueRowByHash(db, contentHash, locationId) {
  if (!locationId) throw new Error('manual-upload hash lookup needs a locationId')
  const { data, error } = await db
    .from('invoices_queue')
    .select('id')
    .eq('location_id', locationId)
    .eq('content_hash', contentHash)
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`manual-upload hash lookup failed: ${error.message}`)
  return { existingId: data?.id || null }
}
