// src/lib/recon/coverage.js
//
// RCOV.P0 — the coverage ledger sync, in four distinct PostgREST calls
// (bulk calls must be shape-uniform — mixing row shapes throws
// PGRST102). Lines previously tracked in the window that no longer
// appear unreconciled have been reconciled in Xero → covered.
// Insert-only semantics for new keys means a terminal covered/ignored
// row is never resurrected (a re-UNreconciled line in Xero stays
// covered here — rare, acceptable for P0).
//
// COMPLETENESS CONTRACT — `lines` MUST be the complete unreconciled
// set for [windowFrom..windowTo]: step 4 derives `covered` from
// absence and covered is terminal, so a partial set silently
// mass-covers. Two lines of defense: the orchestrator's zero-rows
// anomaly guard (first — a fully-empty parse never reaches this
// function), and the covered-ratio circuit-breaker before step 4
// (second — a PARTIAL parse that slips past the zero-rows guard
// throws here instead of mass-covering). The breaker has one documented
// bypass: `acceptMassCover` — the manual refresh route's `force` flag,
// for a legitimate bulk reconcile in Xero that would otherwise re-trip
// the breaker on every retry until the tracked ratio dilutes below 50%.
//
// CONCURRENCY — the four calls are non-transactional and step 4 is a
// one-way ratchet: a transiently-wrong cover from a stale concurrent
// run wins permanently. The orchestrator serializes runs per location;
// this function does not lock.
//
// bank_account_name is set once at insert (display convenience —
// identity is xero_bank_account_id) and never refreshed.
//
// Producer contract: every line must carry `key` (minted by
// computeLineKey in ./bank-statement); a missing key is a producer
// bug (NOT NULL rejects the insert).
const NON_TERMINAL = ['uncovered', 'submitted', 'not_found', 'needs_attention']
const PAGE = 1000 // supabase-js hard select cap — paginate everything
const CHUNK = 300 // house cap for .in()/bulk payloads (cf. fetchContactsByIds in churn-radar-data.js)

async function selectExistingInWindow(db, { locationId, bankAccountId, windowFrom, windowTo }) {
  const all = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('recon_bank_lines')
      .select('id, xero_line_key, status')
      .eq('location_id', locationId)
      .eq('xero_bank_account_id', bankAccountId)
      .in('status', NON_TERMINAL)
      // NAMESPACE GUARD — csv: lines come from the operator's statement
      // CSV upload (import-statement.js) and are NEVER in an API pull's
      // key set. Without this filter, step 4 would mass-cover every
      // CSV-imported line on the next refresh. The API pull owns only
      // its own (bt:) namespace; csv: rows are covered by re-upload or
      // row actions.
      .not('xero_line_key', 'like', 'csv:%')
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
  acceptMassCover,
}) {
  // 1. what we already track (non-terminal) in this window
  const existing = await selectExistingInWindow(db, { locationId, bankAccountId, windowFrom, windowTo })
  const existingKeys = new Set(existing.map((r) => r.xero_line_key))
  const pulledKeys = new Set(lines.map((l) => l.key))
  const nowIso = new Date().toISOString()

  // 2. brand-new keys → insert (conflict-ignore protects terminal rows).
  // Chunked: a cold first pull can be a whole quarter of lines.
  const newLines = lines.filter((l) => !existingKeys.has(l.key))
  const newRows = newLines.map((l) => ({
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
  }))
  for (let i = 0; i < newRows.length; i += CHUNK) {
    const { error } = await db.from('recon_bank_lines').upsert(
      newRows.slice(i, i + CHUNK),
      { onConflict: 'location_id,xero_line_key', ignoreDuplicates: true }
    )
    if (error) throw new Error(`recon insert failed: ${error.message}`)
  }

  // 3. keys seen again → refresh last_seen (never touch lifecycle status)
  const seenAgain = lines.filter((l) => existingKeys.has(l.key)).map((l) => l.key)
  for (let i = 0; i < seenAgain.length; i += CHUNK) {
    const { error } = await db
      .from('recon_bank_lines')
      .update({ last_seen_at: nowIso, updated_at: nowIso })
      .eq('location_id', locationId)
      .eq('xero_bank_account_id', bankAccountId)
      .in('xero_line_key', seenAgain.slice(i, i + CHUNK))
    if (error) throw new Error(`recon refresh failed: ${error.message}`)
  }

  // 4. tracked keys that vanished from the unreconciled set → covered
  const vanished = existing.filter((r) => !pulledKeys.has(r.xero_line_key)).map((r) => r.id)
  // Covered-ratio circuit-breaker (see COMPLETENESS CONTRACT above):
  // a PARTIAL report parse (header intact, some sections dropped) gets
  // past the orchestrator's zero-rows guard — rows.length > 0 — and
  // would mass-cover here. >50% of ≥10 tracked lines vanishing in one
  // pull is never a normal weekly delta. Throw before the one-way cover
  // ratchet; steps 1–3 having already run is fine (idempotent — the
  // next good pull heals). The ≥10 floor keeps small accounts, where a
  // full batch-reconcile is plausible, from tripping it.
  //
  // acceptMassCover bypasses the breaker for a deliberate bulk reconcile
  // (the manual refresh route's `force` flag) — see COMPLETENESS
  // CONTRACT above.
  if (!acceptMassCover && existing.length >= 10 && vanished.length > existing.length * 0.5) {
    // .code is the machine contract (cf. XeroError.code in
    // @/lib/xero/client) — consumers branch on it, never on the prose.
    throw Object.assign(
      new Error(`recon cover-guard tripped: ${vanished.length} of ${existing.length} tracked lines vanished in one pull — possible partial report; cover skipped`),
      { code: 'recon_cover_guard' }
    )
  }
  for (let i = 0; i < vanished.length; i += CHUNK) {
    const { error } = await db
      .from('recon_bank_lines')
      .update({ status: 'covered', covered_at: nowIso, updated_at: nowIso })
      .in('id', vanished.slice(i, i + CHUNK))
    if (error) throw new Error(`recon cover-update failed: ${error.message}`)
  }

  // `new` counts ATTEMPTED inserts — a key colliding with a terminal
  // row no-ops in the DB (ignoreDuplicates) but still counts here.
  // Reporting-only drift, accepted for P0.
  return { pulled: lines.length, new: newLines.length, covered: vanished.length }
}
