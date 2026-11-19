// checkedWrite — one way to run a database write and know whether it happened.
//
// A supabase write RESOLVES with { data, error } instead of throwing, and an
// UPDATE that matches no row is not an error at all. So `await db.from(t)
// .update(u).eq(…)` on its own reports success whether or not anything was
// written, and a try/catch around it can never fire.
//
//   const r = await checkedWrite('bca-submit', () =>
//     db.from('car_bca_submissions').update({ postmark_message_id: id }).eq('id', sid).select('id'),
//   { message: 'sent marker not saved', expectRows: 1, retries: 1, meta: { sid } })
//   if (!r.ok) …
//
// `run` is a function returning the query, so a retry sends it again.
// Options:
//   message     what failed, for the log line.
//   expectRows  a number, or 'some' (at least one). The query must end in
//               .select(…) for its rows to come back; without it the count is 0.
//   retries     extra attempts after a failure (default 0). Only for writes that
//               are safe to repeat: an update to fixed values, never an insert
//               without a unique key behind it.
//   meta        extra fields for the log line. No customer details.
// Returns { ok, data, error, rows }. A failure is logged with logError; deciding
// what it means for the request stays with the caller. Never fail closed on a
// customer-facing step just because a bookkeeping write was lost (CLAUDE.md,
// "Removing a silent failure must NEVER create a louder one").

import { logError } from '@/lib/log'

/**
 * @param {string} scope
 * @param {() => PromiseLike<{ data?: unknown, error?: unknown }>} run
 * @param {{ message?: string, expectRows?: number | 'some', retries?: number, meta?: Record<string, unknown> }} [options]
 * @returns {Promise<{ ok: boolean, data: unknown, error: unknown, rows: number }>}
 */
export async function checkedWrite(scope, run, options = {}) {
  const { message = 'write failed', expectRows, retries = 0, meta = {} } = options
  let last = { ok: false, data: null, error: null, rows: 0 }
  for (let attempt = 0; attempt <= retries; attempt++) {
    let result
    try {
      result = await run()
    } catch (err) {
      result = { data: null, error: err }
    }
    const data = result?.data ?? null
    const rows = Array.isArray(data) ? data.length : data ? 1 : 0
    const error = result?.error ?? null
    const rowsOk = expectRows === undefined || (expectRows === 'some' ? rows > 0 : rows === expectRows)
    last = { ok: !error && rowsOk, data, error, rows }
    if (last.ok) return last
  }
  logError(scope, message, {
    ...meta,
    ...(last.error ? { err: last.error } : { rows: last.rows, expected_rows: expectRows }),
    attempts: retries + 1,
  })
  return last
}
