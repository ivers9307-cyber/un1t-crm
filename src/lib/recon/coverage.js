// src/lib/recon/coverage.js
//
// RCOV.P0 — the coverage ledger sync, in four distinct PostgREST calls
// (bulk calls must be shape-uniform — mixing row shapes throws
// PGRST102). Lines previously tracked in the window that no longer
// appear unreconciled have been reconciled in Xero → covered.
// Insert-only semantics for new keys means a terminal covered/ignored
// row is never resurrected (a re-UNreconciled line in Xero stays
// covered here — rare, acceptable for P0).
const NON_TERMINAL = ['uncovered', 'submitted', 'not_found', 'needs_attention']
const PAGE = 1000 // supabase-js hard select cap — paginate everything

async function selectExistingInWindow(db, { locationId, bankAccountId, windowFrom, windowTo }) {
  const all = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('recon_bank_lines')
      .select('id, xero_line_key, status')
      .eq('location_id', locationId)
      .eq('xero_bank_account_id', bankAccountId)
      .in('status', NON_TERMINAL)
      .gte('line_date', windowFrom)
      .lte('line_date', windowTo)
      .order('id')
      .range(start, start + PAGE - 1)
    if (error) throw new Error(`recon select failed: ${error.message}`)
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return all
}

export async function syncBankLines(db, {
  locationId, bankAccountId, bankAccountName, windowFrom, windowTo, lines,
}) {
  // 1. what we already track (non-terminal) in this window
  const existing = await selectExistingInWindow(db, { locationId, bankAccountId, windowFrom, windowTo })
  const existingKeys = new Set(existing.map((r) => r.xero_line_key))
  const pulledKeys = new Set(lines.map((l) => l.key))
  const nowIso = new Date().toISOString()

  // 2. brand-new keys → insert (conflict-ignore protects terminal rows)
  const newLines = lines.filter((l) => !existingKeys.has(l.key))
  if (newLines.length > 0) {
    const { error } = await db.from('recon_bank_lines').upsert(
      newLines.map((l) => ({
        location_id: locationId,
        xero_bank_account_id: bankAccountId,
        bank_account_name: bankAccountName,
        xero_line_key: l.key,
        line_date: l.date,
        amount: l.amount,
        description: l.description,
        reference: l.reference,
        status: 'uncovered',
        last_seen_at: nowIso,
        updated_at: nowIso,
      })),
      { onConflict: 'location_id,xero_line_key', ignoreDuplicates: true }
    )
    if (error) throw new Error(`recon insert failed: ${error.message}`)
  }

  // 3. keys seen again → refresh last_seen (never touch lifecycle status)
  const seenAgain = lines.filter((l) => existingKeys.has(l.key)).map((l) => l.key)
  if (seenAgain.length > 0) {
    const { error } = await db
      .from('recon_bank_lines')
      .update({ last_seen_at: nowIso, updated_at: nowIso })
      .eq('location_id', locationId)
      .eq('xero_bank_account_id', bankAccountId)
      .in('xero_line_key', seenAgain)
    if (error) throw new Error(`recon refresh failed: ${error.message}`)
  }

  // 4. tracked keys that vanished from the unreconciled set → covered
  const vanished = existing.filter((r) => !pulledKeys.has(r.xero_line_key)).map((r) => r.id)
  if (vanished.length > 0) {
    const { error } = await db
      .from('recon_bank_lines')
      .update({ status: 'covered', covered_at: nowIso, updated_at: nowIso })
      .in('id', vanished)
    if (error) throw new Error(`recon cover-update failed: ${error.message}`)
  }

  return { pulled: lines.length, new: newLines.length, covered: vanished.length }
}
