// FINALTIDY.1 — the expense approvals inbox never offers a viewer their OWN
// claim: /api/expenses/[id]/approve refuses a claimant deciding it (master
// included), so listing it as approvable would only lead to a 403.

import { describe, it, expect } from 'vitest'
import { fteExpensesProvider } from './fte-expenses.js'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const ME = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'

const ROWS = [
  { id: 'c-mine', profile_id: ME, location_id: LOC, status: 'submitted', period_start: '2026-09-01', item_count: 1, total_amount: 10, profile: { full_name: 'Me' } },
  { id: 'c-theirs', profile_id: OTHER, location_id: LOC, status: 'submitted', period_start: '2026-09-01', item_count: 2, total_amount: 20, profile: { full_name: 'Them' } },
]

// Applies eq / neq filters to ROWS, so the provider's own filters decide.
function fakeDb() {
  return {
    from: () => {
      const filters = []
      let head = false
      const q = {
        select: (_c, opts) => { head = !!opts?.head; return q },
        eq: (c, v) => { filters.push((r) => r[c] === v); return q },
        neq: (c, v) => { filters.push((r) => r[c] !== v); return q },
        order: () => q,
        limit: () => q,
        then: (onF, onR) => {
          const rows = ROWS.filter((r) => filters.every((f) => f(r)))
          return Promise.resolve(head ? { count: rows.length, error: null } : { data: rows, error: null }).then(onF, onR)
        },
      }
      return q
    },
  }
}

const viewer = { id: ME, role: 'owner', activeLocation: { id: LOC } }

describe('fteExpensesProvider — own claims are not approvable', () => {
  it('fetchPending excludes the viewer’s own claim', async () => {
    const { count, items } = await fteExpensesProvider.fetchPending(fakeDb(), viewer)
    expect(items.map((i) => i.id)).toEqual(['c-theirs'])
    expect(count).toBe(1)
  })

  it('countPending excludes it too, so the badge matches the list', async () => {
    expect(await fteExpensesProvider.countPending(fakeDb(), viewer)).toBe(1)
  })

  it('a master viewer is not exempt', async () => {
    const { items } = await fteExpensesProvider.fetchPending(fakeDb(), { ...viewer, role: 'master' })
    expect(items.map((i) => i.id)).toEqual(['c-theirs'])
  })
})
