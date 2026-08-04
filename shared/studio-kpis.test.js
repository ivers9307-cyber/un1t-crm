// STUDIO-KPI.3 — the rolling-window comparator must not compare against
// a window that predates the data source. membership_transitions only
// began logging on 2026-07-29 (mig 456), so a "previous 28 days" window
// starting before that is empty because nothing was RECORDED, not
// because nothing happened — rendering a delta against it would show a
// flattering improvement that never occurred.

import { describe, it, expect } from 'vitest'
import { fetchGrowth } from './studio-kpis.js'

// Serves a canned { count } per from() call, in call order, and records
// the filters each builder saw.
function countingSupabase(counts) {
  const seen = []
  let i = 0
  return {
    seen,
    from() {
      const calls = []
      const result = { count: counts[i++] ?? 0, error: null }
      const b = {}
      for (const m of ['select', 'eq', 'gte', 'lt', 'order', 'range']) {
        b[m] = (...args) => { calls.push([m, ...args]); return b }
      }
      b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
      seen.push(calls)
      return b
    },
  }
}

describe('fetchGrowth', () => {
  // Order matches the Promise.all: starts, cancels, prevStarts, prevCancels.
  const counts = [5, 2, 1, 1] // net 3 now, net 0 before

  it('reports the delta when both windows are inside the tracked period', async () => {
    const supabase = countingSupabase(counts)
    const res = await fetchGrowth(supabase, 'loc1', new Date('2026-10-01T12:00:00Z'))

    expect(res.success).toBe(true)
    expect(res.data.netRecurring).toBe(3)
    expect(res.data.netRecurringDelta).toBe(3)
    expect(res.data.windowDays).toBe(28)
  })

  it('suppresses the delta when the comparator window predates the mig 456 trigger', async () => {
    const supabase = countingSupabase(counts)
    // prev window = 2026-07-07 → 2026-08-04, i.e. starts before 07-29.
    const res = await fetchGrowth(supabase, 'loc1', new Date('2026-08-04T12:00:00Z'))

    expect(res.data.netRecurring).toBe(3)
    expect(res.data.netRecurringDelta).toBe(null)
  })

  it('windows the current period on occurred_at and bounds the previous one', async () => {
    const supabase = countingSupabase(counts)
    await fetchGrowth(supabase, 'loc1', new Date('2026-10-01T12:00:00Z'))

    const [currentStarts, , prevStarts] = supabase.seen
    // Current window is open-ended at the top (up to now); the previous
    // one is closed so the two never overlap.
    expect(currentStarts.some(c => c[0] === 'lt')).toBe(false)
    expect(prevStarts.some(c => c[0] === 'lt')).toBe(true)

    const curFrom = currentStarts.find(c => c[0] === 'gte')[2]
    const prevTo = prevStarts.find(c => c[0] === 'lt')[2]
    expect(prevTo).toBe(curFrom)
  })

  it('refuses without a location', async () => {
    const res = await fetchGrowth(countingSupabase([]), null)
    expect(res).toEqual({ success: false, error: 'No location' })
  })
})
