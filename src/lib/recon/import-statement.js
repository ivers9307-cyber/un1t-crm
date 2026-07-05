// src/lib/recon/import-statement.js
//
// RCOV CSV bridge — write the parsed statement lines into the ledger.
//
// Semantics differ from coverage.syncBankLines ON PURPOSE:
// - INSERT-ONLY plus explicit cover. A CSV is whatever window the
//   operator happened to export — treating absence as "reconciled"
//   (the API pull's vanish-cover) would mass-cover on every partial
//   export. A csv: line is covered only when a LATER upload shows the
//   SAME line (same identity key) with status Reconciled — or via the
//   row actions (upload receipt / ignore).
// - CROSS-SOURCE DEDUPE at insert: a statement line whose (date,
//   amount) matches a non-terminal API-tracked (bt:) line for the
//   same account is the same money leaving the bank — skipped, not
//   double-tracked. Same-day same-amount PAIRS of distinct payments
//   are collateral here (skipped too) — accepted: rarer than the
//   dupe, and the receipt need is usually satisfied by the bt: line's
//   hunt anyway.
//
// The API pull cannot touch csv: rows (syncBankLines scopes its
// vanish-cover to the bt: namespace) — the two sources co-own the
// ledger but never cover each other's lines.
const NON_TERMINAL = ['uncovered', 'submitted', 'not_found', 'needs_attention']
const PAGE = 1000 // supabase-js hard select cap — paginate everything
const CHUNK = 300 // house bulk-payload cap (cf. coverage.js)

async function selectNonTerminal(db, { locationId, bankAccountId, windowFrom, windowTo }) {
  const all = []
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db
      .from('recon_bank_lines')
      .select('id, xero_line_key, line_date, amount')
      .eq('location_id', locationId)
      .eq('xero_bank_account_id', bankAccountId)
      .in('status', NON_TERMINAL)
      .gte('line_date', windowFrom)
      .lte('line_date', windowTo)
      .order('id')
      .range(start, start + PAGE - 1)
    if (error) throw new Error(`statement import select failed: ${error.message}`)
    all.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return all
}

const tuple = (date, amount) => `${date}|${Number(amount).toFixed(2)}`

// lines = csvLineRows output (unreconciled money-out, csv: keys);
// reconciledKeys = csvReconciledKeys output. Both minted from the same
// ordinal-assigned full parse.
export async function importStatementLines(db, {
  locationId, bankAccountId, bankAccountName, lines, reconciledKeys,
}) {
  if (lines.length === 0 && reconciledKeys.length === 0) {
    return { tracked: 0, duplicates: 0, alreadyTracked: 0, covered: 0 }
  }
  const dates = [...lines.map((l) => l.date)].sort()
  // Cover candidates can predate this upload's unreconciled lines —
  // widen the lookup window to everything non-terminal for the account
  // when only reconciled keys bound it. Cheap either way (per-account).
  const windowFrom = dates[0] || '1900-01-01'
  const windowTo = dates[dates.length - 1] || '2999-12-31'
  const existing = await selectNonTerminal(db, {
    locationId, bankAccountId,
    windowFrom: reconciledKeys.length > 0 ? '1900-01-01' : windowFrom,
    windowTo: reconciledKeys.length > 0 ? '2999-12-31' : windowTo,
  })
  const existingKeys = new Set(existing.map((r) => r.xero_line_key))
  const apiTuples = new Set(
    existing.filter((r) => !r.xero_line_key.startsWith('csv:')).map((r) => tuple(r.line_date, r.amount))
  )

  const fresh = lines.filter((l) => !existingKeys.has(l.key))
  const alreadyTracked = lines.length - fresh.length
  const duplicates = fresh.filter((l) => apiTuples.has(tuple(l.date, l.amount)))
  const inserts = fresh.filter((l) => !apiTuples.has(tuple(l.date, l.amount)))

  const nowIso = new Date().toISOString()
  const newRows = inserts.map((l) => ({
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
    // conflict-ignore: a key colliding with a TERMINAL row (covered/
    // ignored in a past cycle) must not resurrect it.
    const { error } = await db.from('recon_bank_lines').upsert(
      newRows.slice(i, i + CHUNK),
      { onConflict: 'location_id,xero_line_key', ignoreDuplicates: true }
    )
    if (error) throw new Error(`statement import insert failed: ${error.message}`)
  }

  const recSet = new Set(reconciledKeys)
  const toCover = existing
    .filter((r) => r.xero_line_key.startsWith('csv:') && recSet.has(r.xero_line_key))
    .map((r) => r.id)
  for (let i = 0; i < toCover.length; i += CHUNK) {
    const { error } = await db
      .from('recon_bank_lines')
      .update({ status: 'covered', covered_at: nowIso, updated_at: nowIso })
      .in('id', toCover.slice(i, i + CHUNK))
    if (error) throw new Error(`statement import cover failed: ${error.message}`)
  }

  return { tracked: inserts.length, duplicates: duplicates.length, alreadyTracked, covered: toCover.length }
}
