// src/lib/recon/clear-board.js
//
// RCOV — "Clear board": delete every OPEN (non-terminal) bank line for
// a location. The recovery hatch for a mistaken statement upload.
//
// - Scope: the active location only, non-terminal statuses only.
//   covered/ignored rows are terminal HISTORY and are kept (so a
//   previously-covered line can't be resurrected by a later re-upload).
// - recon_hunts has an FK into recon_bank_lines with no ON DELETE
//   CASCADE, so child hunt rows must be deleted FIRST or the line
//   delete trips a foreign-key violation.
// - Audited as a recon_runs row (trigger 'clear') so the wipe is
//   visible in the Runs & health tab: who, when, how many.
//
// Recoverable: bt: lines return on the next "Refresh from Xero"; csv:
// lines return on the next statement re-upload. Receipts already
// pushed to Xero (invoices_queue rows / DRAFT bills) are NOT touched —
// only the coverage-tracking rows are removed.
const NON_TERMINAL = ['uncovered', 'submitted', 'not_found', 'needs_attention']
const PAGE = 1000 // supabase-js hard select cap — paginate
const CHUNK = 300 // house bulk-payload cap for .in()

export async function clearOpenLines(db, locationId, userId) {
  const ids = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('recon_bank_lines')
      .select('id')
      .eq('location_id', locationId)
      .in('status', NON_TERMINAL)
      .order('id')
      .range(start, start + PAGE - 1)
    if (error) throw new Error(`clear select failed: ${error.message}`)
    ids.push(...(data || []).map((r) => r.id))
    if (!data || data.length < PAGE) break
  }

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK)
    // Children first (FK), then the lines.
    const { error: hErr } = await db.from('recon_hunts').delete().in('bank_line_id', chunk)
    if (hErr) throw new Error(`clear hunts failed: ${hErr.message}`)
    const { error: lErr } = await db.from('recon_bank_lines').delete().in('id', chunk)
    if (lErr) throw new Error(`clear lines failed: ${lErr.message}`)
  }

  // Best-effort audit — never fail the clear on a bookkeeping insert.
  try {
    await db.from('recon_runs').insert({
      location_id: locationId,
      trigger: 'clear',
      status: 'ok',
      finished_at: new Date().toISOString(),
      stats: { cleared: ids.length, clearedBy: userId },
    })
  } catch {
    // audit is diagnostic only
  }

  return { cleared: ids.length }
}
