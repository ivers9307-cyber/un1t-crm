// ZOOMSYNC.1 — CRM → the directory we want Zoom to hold.
//
// Owns three rules: ClassPass is excluded, numbers are normalised to E.164,
// and where two profiles share a number the OLDEST profile supplies the name.

import { normaliseForZoom } from './normalise-phone'

const PAGE_SIZE = 1000       // PostgREST caps every select at 1000 rows
const HARD_LIMIT = 40_000    // ~6.7k today; crossing this means streaming, not a bigger number
const SELECT_COLS = 'id, first_name, last_name, phone, lead_source, created_at'

/**
 * Date.parse(...) returns NaN for a genuinely unparseable/missing value, but
 * returns the number 0 for a legitimately-valid Unix-epoch timestamp — and 0
 * is falsy. A `Date.parse(x) || FALLBACK` guard would conflate the two,
 * shoving a real epoch date to "effectively newest" instead of letting it win
 * as the oldest. `contacts.created_at` is a nullable timestamptz, so a bad
 * backfill or import leaving a row at the epoch is a real possibility this
 * must still resolve correctly. Test with Number.isNaN, not truthiness.
 */
function parsedTime(value) {
  const t = Date.parse(value ?? '')
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}

/**
 * Oldest profile wins. `contacts.id` breaks a created_at tie so two rows
 * written in the same transaction cannot flip the name between runs.
 */
export function pickWinner(a, b) {
  const ta = parsedTime(a.created_at)
  const tb = parsedTime(b.created_at)
  if (ta !== tb) return ta < tb ? a : b
  return String(a.id) < String(b.id) ? a : b
}

function nameOf(row) {
  return [row.first_name, row.last_name]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(' ')
}

/**
 * @returns {Promise<{ok: true, desired: Map<string, {name: string, contactId: string}>, stats: object}
 *                 | {ok: false, error: string}>}
 */
export async function buildDesiredContacts(db) {
  const stats = { scanned: 0, excludedClassPass: 0, rejected: 0, noName: 0, collapsed: 0 }
  const winners = new Map() // e164 → row

  let pageStart = 0
  while (true) {
    const pageEnd = Math.min(pageStart + PAGE_SIZE - 1, HARD_LIMIT - 1)
    // Supabase builders are thenables, not Promises — no .catch() here.
    const { data: page, error } = await db
      .from('contacts')
      .select(SELECT_COLS)
      .order('id', { ascending: true })
      .range(pageStart, pageEnd)

    if (error) return { ok: false, error: `contact load: ${error.message}` }
    if (!Array.isArray(page) || page.length === 0) break

    for (const row of page) {
      stats.scanned++

      if (String(row.lead_source ?? '').toLowerCase() === 'classpass') {
        stats.excludedClassPass++
        continue
      }
      const e164 = normaliseForZoom(row.phone)
      if (!e164) { stats.rejected++; continue }
      if (!nameOf(row)) { stats.noName++; continue }

      const held = winners.get(e164)
      if (!held) { winners.set(e164, row); continue }
      stats.collapsed++
      winners.set(e164, pickWinner(held, row))
    }

    if (page.length < PAGE_SIZE) break
    pageStart += PAGE_SIZE
    if (pageStart >= HARD_LIMIT) break
  }

  const desired = new Map()
  for (const [e164, row] of winners) {
    desired.set(e164, { name: nameOf(row), contactId: String(row.id) })
  }
  return { ok: true, desired, stats }
}
