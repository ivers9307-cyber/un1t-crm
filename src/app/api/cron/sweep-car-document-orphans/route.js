import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { logError, logInfo } from '@/lib/log'
import { parseCarDocumentUploadPath } from '@/lib/car-document-upload'
import { ALL_DOCUMENT_TYPES } from '@/lib/cars'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/** The private bucket this sweeps. Nothing else is ever listed or touched. */
export const BUCKET = 'car-documents'
/** An upload younger than this may still be finalised. */
export const ORPHAN_MIN_AGE_HOURS = 24
/** Paths per Storage remove call. */
export const REMOVE_CHUNK = 100
/** Objects removed per run at most; the rest wait for the next day. */
export const MAX_REMOVE_PER_RUN = 500
/** The cron_heartbeats row (mig 694). */
export const HEARTBEAT_NAME = 'sweep-car-document-orphans'
/** Entries per Storage list call (Storage's own default page). */
const LIST_PAGE = 100
/** Paths per `.in()` reference read: about 90 characters each, so the URL stays short. */
const REF_CHUNK = 50
/** Runaway guard on Storage list calls in one run. */
const MAX_LIST_CALLS = 2000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DOC_TYPE_KEYS = new Set(ALL_DOCUMENT_TYPES.map((t) => t.key))

/**
 * GET /api/cron/sweep-car-document-orphans — CARDOCORPHANS.1 (C130).
 *
 * WHY. Since CARDOCUPLOAD.1 (C124) the browser puts a car document straight
 * into the private car-documents bucket against a slot the sign route mints
 * (`<car uuid>/<doc_type>/<uuid>.<ext>`), then calls finalise, which records
 * the car_documents row. An upload whose finalise fails or never runs (the
 * tab closed) leaves an object nothing references and nothing would ever
 * delete: a buyer's or a supplier's invoice, kept for good. Richard's
 * decision (1 Oct 2026): a daily sweep.
 *
 * WHAT IS REMOVED. An object is removed only when ALL of these hold:
 *   1. its whole path is a slot the sign route can mint:
 *      parseCarDocumentUploadPath (src/lib/car-document-upload.js), the same
 *      name rule finalise checks with isCarDocumentUploadPath, for a doc type
 *      in ALL_DOCUMENT_TYPES. The Xero sales-invoice PDFs under `cars/`
 *      (cars.xero_invoice_pdf_path), the multipart route's
 *      `<ts>-<rand>-<name>` files and every other shape fail it, so they are
 *      never touched, whatever their age; `cars/` is not even listed.
 *   2. Storage's created_at says it is more than ORPHAN_MIN_AGE_HOURS old (a
 *      missing or unreadable date keeps it: the sweep never guesses an age).
 *      Finalise runs seconds after the upload, so 24 h is far past any
 *      upload still in flight.
 *   3. no car_documents.storage_path names it, and no invoices_queue row
 *      with attachment_bucket 'car-documents' names it in attachment_path
 *      (queue rows copy the car_documents path; checked anyway).
 *
 * HOW. Storage API on the service client only: list the bucket root, each
 * `<car uuid>` folder, then each `<doc_type>` folder in it (paged by
 * LIST_PAGE), keep the files that pass 1 and 2, read references in chunks of
 * REF_CHUNK, then remove the oldest MAX_REMOVE_PER_RUN orphans in chunks of
 * REMOVE_CHUNK. The count comes from what Storage says it removed.
 *
 * FAIL CLOSED. Every list and every reference read is checked; any failure
 * stops the run BEFORE anything is removed (an unreadable folder or table
 * could hide a reference), answers 500 and does NOT stamp. A failed remove
 * answers 500 and does not stamp. A clean run stamps, including one with
 * nothing to remove and one that hit the cap. Logs and the heartbeat outcome
 * carry counts only, never a path.
 *
 * ACCEPTED RACE. None in practice: an object old enough to sweep was signed
 * at least a day ago, and finalise is called right after the upload.
 *
 * Secured by CRON_SECRET. Heartbeat row: mig 694. vercel.json: daily 04:25 UTC.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const db = createServerClient()
  const bucket = db.storage.from(BUCKET)
  const nowMs = Date.now()
  const olderThanMs = nowMs - ORPHAN_MIN_AGE_HOURS * 60 * 60 * 1000
  const counts = { scanned_objects: 0, matching: 0, too_young: 0, undated: 0, referenced: 0, orphans_found: 0, removed: 0 }
  const fail = (step, message) => {
    const outcome = { ...counts, older_than: new Date(olderThanMs).toISOString(), cap_reached: false }
    logError('cron.sweep-car-document-orphans', `${step} failed, nothing more removed, not stamping`, { ...outcome, err: message })
    return NextResponse.json({ success: false, error: `sweep failed at the ${step}: ${message}`, data: outcome }, { status: 500 })
  }

  // ── 1. Find the candidates: slot-shaped, old enough. ─────────────────
  const lister = makeLister(bucket)
  const root = await lister.listAll('')
  if (root.error) return fail('bucket list', root.error)
  const candidates = []
  for (const carFolder of root.entries) {
    if (carFolder.id !== null || !UUID_RE.test(carFolder.name)) continue // a file, `cars/`, or another shape
    const car = await lister.listAll(carFolder.name)
    if (car.error) return fail('car folder list', car.error)
    for (const typeFolder of car.entries) {
      if (typeFolder.id !== null || !DOC_TYPE_KEYS.has(typeFolder.name)) continue
      const prefix = `${carFolder.name}/${typeFolder.name}`
      const files = await lister.listAll(prefix)
      if (files.error) return fail('doc type folder list', files.error)
      for (const f of files.entries) {
        if (f.id === null) continue // a deeper folder: not a slot
        counts.scanned_objects += 1
        const path = `${prefix}/${f.name}`
        if (!parseCarDocumentUploadPath(path)) continue
        counts.matching += 1
        const createdMs = Date.parse(f.created_at || '')
        if (!Number.isFinite(createdMs)) { counts.undated += 1; continue }
        if (createdMs >= olderThanMs) { counts.too_young += 1; continue }
        candidates.push({ path, createdMs })
      }
    }
  }

  // ── 2. Drop every candidate something references. ─────────────────────
  const refs = await referencedPaths(db, candidates.map((c) => c.path))
  if (refs.error) return fail(refs.step, refs.error)
  counts.referenced = refs.paths.size
  const orphans = candidates
    .filter((c) => !refs.paths.has(c.path))
    .sort((a, b) => a.createdMs - b.createdMs || (a.path < b.path ? -1 : 1))
  counts.orphans_found = orphans.length
  const capReached = orphans.length > MAX_REMOVE_PER_RUN
  const toRemove = orphans.slice(0, MAX_REMOVE_PER_RUN).map((o) => o.path)

  // ── 3. Remove, in chunks. ─────────────────────────────────────────────
  for (let i = 0; i < toRemove.length; i += REMOVE_CHUNK) {
    const chunk = toRemove.slice(i, i + REMOVE_CHUNK)
    const { data: gone, error } = await bucket.remove(chunk)
    if (error) return fail('remove', error.message)
    counts.removed += Array.isArray(gone) ? gone.length : 0
  }

  const outcome = {
    ...counts,
    older_than: new Date(olderThanMs).toISOString(),
    cap_reached: capReached,
    scan_truncated: lister.truncated(),
  }
  logInfo('cron.sweep-car-document-orphans', 'run complete', outcome)
  await stampHeartbeat(HEARTBEAT_NAME, outcome)
  return NextResponse.json({ success: true, data: outcome })
}

/**
 * A paged folder lister with a run-wide call budget. Supabase Storage lists
 * one level: files carry an id, sub-folders come back with `id: null`.
 * Past the budget it stops listing (scan_truncated) rather than run away; a
 * partial scan only finds fewer candidates, each still checked in full.
 */
function makeLister(bucket) {
  let calls = 0
  let truncated = false
  return {
    truncated: () => truncated,
    async listAll(prefix) {
      const entries = []
      for (let offset = 0; ; offset += LIST_PAGE) {
        if (calls >= MAX_LIST_CALLS) { truncated = true; return { entries, error: null } }
        calls += 1
        const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: 'name', order: 'asc' } })
        if (error) return { entries, error: error.message || String(error) }
        const page = Array.isArray(data) ? data : []
        for (const e of page) {
          if (e && typeof e.name === 'string') entries.push({ name: e.name, id: e.id ?? null, created_at: e.created_at ?? null })
        }
        if (page.length < LIST_PAGE) return { entries, error: null }
      }
    },
  }
}

/**
 * The subset of `paths` that car_documents.storage_path or an invoices_queue
 * car-documents attachment names. Chunked; never throws on a PostgREST error.
 *
 * @returns {Promise<{ paths: Set<string>, error: string|null, step?: string }>}
 */
async function referencedPaths(db, paths) {
  const found = new Set()
  for (let i = 0; i < paths.length; i += REF_CHUNK) {
    const chunk = paths.slice(i, i + REF_CHUNK)
    const { data: docs, error: docErr } = await db.from('car_documents')
      .select('storage_path')
      .in('storage_path', chunk)
    if (docErr) return { paths: found, error: docErr.message, step: 'car_documents read' }
    for (const d of docs || []) if (d?.storage_path) found.add(d.storage_path)

    const { data: queued, error: qErr } = await db.from('invoices_queue')
      .select('attachment_path')
      .eq('attachment_bucket', BUCKET)
      .in('attachment_path', chunk)
    if (qErr) return { paths: found, error: qErr.message, step: 'invoices_queue read' }
    for (const q of queued || []) if (q?.attachment_path) found.add(q.attachment_path)
  }
  return { paths: found, error: null }
}
