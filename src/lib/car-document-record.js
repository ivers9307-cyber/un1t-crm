// CARDOCUPLOAD.1 (C124) — what happens once a car document's bytes are in
// the 'car-documents' bucket, shared by the multipart route
// (POST /api/cars/[id]/documents) and the signed-upload finalise
// (…/documents/finalise) so both record a document the same way:
//   1. the car_documents row (same columns);
//   2. if that insert fails, the stored object is removed (no orphans),
//      EXCEPT when the path is already recorded (CARDOCUNIQUE.1, mig 693:
//      car_documents_storage_path_key). Two concurrent finalise calls on
//      one slot both pass the route's read-then-insert check; the loser's
//      insert fails 23505 and the object it would remove is the winner's.
//      That is { ok: false, conflict: true }, which both routes answer 409;
//   3. INVOICES-QUEUE.1 — the document auto-queues for the bookkeeper
//      (/invoices, where the OCR and the Xero push happen). Best effort: the
//      upload succeeded, so a queue failure is logged and returned as
//      queue_warning, never un-done; ops can retry from the queue UI.

import { enqueueFromCarDocument } from '@/lib/invoices-queue/enqueue'
import { logWarn } from '@/lib/log'

export const CAR_DOCUMENT_ALREADY_SAVED = 'This upload is already saved.'
const PATH_UNIQUE_INDEX = 'car_documents_storage_path_key'

/** True when an insert error is the unique storage_path (mig 693), never another unique key. */
export function isCarDocumentPathConflict(error) {
  if (!error || error.code !== '23505') return false
  return `${error.message || ''} ${error.details || ''}`.includes(PATH_UNIQUE_INDEX)
}

/**
 * @returns {Promise<{ ok: true, doc: object, queueWarning?: string } | { ok: false, error: string, conflict?: true }>}
 */
export async function recordCarDocument(db, { car, docType, storagePath, filename, mimeType, sizeBytes, userId, notes }) {
  const { data: doc, error: insertErr } = await db.from('car_documents').insert({
    car_id: car.id,
    doc_type: docType,
    storage_path: storagePath,
    filename,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    uploaded_by: userId,
    notes,
  }).select().single()

  if (insertErr) {
    // Already recorded: the object belongs to that row, so it stays.
    if (isCarDocumentPathConflict(insertErr)) return { ok: false, conflict: true, error: CAR_DOCUMENT_ALREADY_SAVED }
    // Roll back the storage upload so we don't leak orphan files.
    try {
      const { error: rmErr } = await db.storage.from('car-documents').remove([storagePath])
      if (rmErr) logWarn('car-documents-upload', 'orphan not removed', { error: rmErr.message })
    } catch (e) {
      logWarn('car-documents-upload', 'orphan not removed', { error: e?.message })
    }
    return { ok: false, error: insertErr.message }
  }

  const enq = await enqueueFromCarDocument(doc.id)
  if (!enq.ok) {
    logWarn('car-documents-upload', 'enqueue failed', { err: enq.error, documentId: doc.id })
  }
  return { ok: true, doc, queueWarning: enq.ok ? undefined : enq.error }
}
