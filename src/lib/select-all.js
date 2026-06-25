// selectAll — read EVERY row out of a PostgREST/Supabase select.
//
// WHY THIS EXISTS
// Supabase projects ship with `db-max-rows` defaulting to 1000: every
// `.select()` returns at most 1000 rows REGARDLESS of `.limit()`, and there
// is no error — the response is just silently truncated. Any awaited fan-out
// that can exceed 1000 rows (sends, imports, backfills, aggregates) must
// `.range()`-paginate with a stable `.order()`, or it corrupts data quietly.
//
// The proven in-repo pattern is the hand-rolled loop in
// `src/lib/pipeline-reclassify.js`; this is that loop, extracted so the simple
// callers don't each re-roll (and mis-roll) it. Sites with an awkward shape
// (chunked IN-lists, per-page virtual-field resolution) still inline their own
// loop — see `fetchAllSmsAudience` in `src/lib/sms.js`.
//
// CONTRACT
//   buildQuery(from, to) MUST return a PostgREST query that already carries
//   BOTH `.order(<stable column>)` AND `.range(from, to)`. selectAll awaits it
//   and reads `{ data, error }`. The order column has to be deterministic
//   (typically `id`) or paging double-counts / skips rows. The builder is
//   invoked fresh per page because supabase-js builders are single-use.
//
// BEHAVIOUR
//   - Loops, accumulating pages, until a page comes back shorter than pageSize
//     (the end of the data) or the hardCap is reached.
//   - Throws on the first page error (mirrors fetchInvoicesByStatus /
//     fetchAllSmsAudience — callers that want best-effort wrap in try/catch).
//   - hardCap is a safety ceiling, not a target: crossing it should prompt a
//     redesign (streaming, server-side aggregation), not a bigger number.

/**
 * Read every row of a paginated PostgREST select.
 *
 * @template T
 * @param {(from: number, to: number) => PromiseLike<{ data: T[]|null, error: any }>} buildQuery
 *   Returns a query already carrying `.order(...).range(from, to)`. Called once
 *   per page (builders are single-use).
 * @param {object} [opts]
 * @param {number} [opts.pageSize=1000]  Rows per page. Must match the project's
 *   db-max-rows ceiling (1000) to detect the final short page correctly.
 * @param {number} [opts.hardCap=50000]  Absolute ceiling on rows returned — a
 *   guard against an unbounded scan, not an expected limit.
 * @returns {Promise<T[]>} every row, concatenated in page order.
 */
export async function selectAll(buildQuery, { pageSize = 1000, hardCap = 50000 } = {}) {
  const rows = []
  let from = 0
  while (true) {
    const to = Math.min(from + pageSize - 1, hardCap - 1)
    const { data, error } = await buildQuery(from, to)
    if (error) throw new Error(error.message || String(error))
    if (!Array.isArray(data) || data.length === 0) break
    rows.push(...data)
    if (data.length < pageSize) break    // short page → end of data
    if (rows.length >= hardCap) break     // safety ceiling reached
    from += pageSize
  }
  return rows
}

// selectAllByKeys — read every row matching an `.in(column, keys)` lookup, when
// the key list itself can be large.
//
// WHY SEPARATE FROM selectAll: an `.in('email', [...])` query has TWO independent
// 1000-caps. (1) The match SET is capped at db-max-rows like any select — so a
// dedup lookup against >1000 existing contacts silently misses matches past 1000,
// and an importer then INSERTs them as DUPLICATES. (2) The key LIST is encoded
// into the URL `?col=in.(a,b,c,…)` and PostgREST 400s "Bad Request" once that
// string runs long. So we chunk the keys (keeping each URL well under the limit)
// AND page within each chunk (so each chunk's full match set comes back).
//
// `buildQuery(keys, from, to)` MUST return a query carrying `.in(column, keys)`
// PLUS `.order(...).range(from, to)`. Returns the de-duplicated-by-page union of
// every chunk's rows (caller dedups by key if a row can match two chunks, which
// it can't here since chunks partition the key set).

/**
 * @template T
 * @param {string[]} keys  the full key list to match (e.g. all emails to look up).
 * @param {(keys: string[], from: number, to: number) => PromiseLike<{ data: T[]|null, error: any }>} buildQuery
 * @param {object} [opts]
 * @param {number} [opts.chunkSize=300]  keys per query — keeps the `in.(…)` URL
 *   comfortably under PostgREST's request-line limit (emails/UUIDs are short;
 *   300 is conservative).
 * @param {number} [opts.pageSize=1000]
 * @param {number} [opts.hardCap=50000]  per-chunk row ceiling.
 * @returns {Promise<T[]>}
 */
export async function selectAllByKeys(keys, buildQuery, { chunkSize = 300, pageSize = 1000, hardCap = 50000 } = {}) {
  const out = []
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize)
    if (chunk.length === 0) continue
    const rows = await selectAll((from, to) => buildQuery(chunk, from, to), { pageSize, hardCap })
    out.push(...rows)
  }
  return out
}
