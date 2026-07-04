// src/lib/recon/statuses.js
//
// RCOV.P1 — the cross-week status machine's two batch operations,
// run during the Friday pull (before hunts are seeded):
//
// sweepSubmittedLines — a line whose hunted document was REJECTED by
// the bookkeeper must stop counting as "in review": flip it to
// needs_attention (terminal for automation; the operator resolves).
// Its rejected find's message-id is excluded from future hunts by
// huntLine's own exclusion query (see hunt.js step 3) — no state
// needed here.
//
// sweepSubmittedLines also has a healing side: a submitted line whose
// queue row was FORWARDED to Xero stays 'submitted' (the Xero-side
// vanish covers it via syncBankLines) — no action. Only 'rejected'
// transitions.
//
// seedHunts — queue every uncovered/not_found line for the drain cron
// (idempotent: only rows not already queued).
const PAGE = 1000
const CHUNK = 300

export async function sweepSubmittedLines(db, locationId) {
  // 1. all submitted lines with a linked queue row (paginated)
  const submitted = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('recon_bank_lines')
      .select('id, invoices_queue_id')
      .eq('location_id', locationId)
      .eq('status', 'submitted')
      .not('invoices_queue_id', 'is', null)
      .order('id')
      .range(start, start + PAGE - 1)
    if (error) throw new Error(`sweep select failed: ${error.message}`)
    submitted.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  if (submitted.length === 0) return { swept: 0, flagged: 0 }

  // 2. their queue rows' statuses, chunked
  const queueIds = [...new Set(submitted.map((r) => r.invoices_queue_id))]
  const rejected = new Set()
  for (let i = 0; i < queueIds.length; i += CHUNK) {
    const { data, error } = await db
      .from('invoices_queue')
      .select('id, status')
      .in('id', queueIds.slice(i, i + CHUNK))
    if (error) throw new Error(`sweep queue lookup failed: ${error.message}`)
    for (const q of data || []) if (q.status === 'rejected') rejected.add(q.id)
  }

  // 3. flip lines whose document was rejected
  const flaggedIds = submitted.filter((r) => rejected.has(r.invoices_queue_id)).map((r) => r.id)
  const nowIso = new Date().toISOString()
  for (let i = 0; i < flaggedIds.length; i += CHUNK) {
    const { error } = await db
      .from('recon_bank_lines')
      .update({ status: 'needs_attention', updated_at: nowIso })
      .in('id', flaggedIds.slice(i, i + CHUNK))
    if (error) throw new Error(`sweep flag update failed: ${error.message}`)
  }
  return { swept: submitted.length, flagged: flaggedIds.length }
}

// NOTE on the seeded-count: `.update().select('id')` returns the
// PostgREST `Prefer: return=representation` rows — supabase-js semantics,
// and matches the house precedent in glofox-reconcile.js's commit loop
// (`written += Array.isArray(data) ? data.length : 0`). Well under the
// 1000-row select cap for a week's worth of newly-uncovered lines, so
// no pagination needed here.
export async function seedHunts(db, locationId) {
  const nowIso = new Date().toISOString()
  const { data, error } = await db
    .from('recon_bank_lines')
    .update({ hunt_queued_at: nowIso, updated_at: nowIso })
    .eq('location_id', locationId)
    .in('status', ['uncovered', 'not_found'])
    .is('hunt_queued_at', null)
    .select('id')
  if (error) throw new Error(`seed failed: ${error.message}`)
  return { seeded: (data || []).length }
}
