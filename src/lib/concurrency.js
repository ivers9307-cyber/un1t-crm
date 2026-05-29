// Small async concurrency pool. Runs `worker` over `items` with at most
// `limit` in flight at once, returns results in input order. Each result
// is { ok: true, value } or { ok: false, error } — one item's failure
// never rejects the whole batch (callers branch per-item). Used by the
// bulk invoice uploader to push N files without bursting the server or
// the browser's connection pool.

/**
 * @template T, R
 * @param {T[]} items
 * @param {number} limit          max concurrent workers (clamped to >= 1)
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: any }>>}
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  const results = new Array(list.length)
  if (list.length === 0) return results
  const poolSize = Math.max(1, Math.min(Math.floor(limit) || 1, list.length))
  let nextIndex = 0

  async function runner() {
    while (true) {
      const i = nextIndex++
      if (i >= list.length) return
      try {
        results[i] = { ok: true, value: await worker(list[i], i) }
      } catch (error) {
        results[i] = { ok: false, error }
      }
    }
  }

  await Promise.all(Array.from({ length: poolSize }, () => runner()))
  return results
}
