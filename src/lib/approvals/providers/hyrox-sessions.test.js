import { describe, it, expect } from 'vitest'
import { hyroxSessionsProvider } from './hyrox-sessions'

function fakeDb(rows) {
  const q = { _f: {}, select() { return this }, eq() { return this }, order() { return this }, limit() { return Promise.resolve({ data: rows, error: null }) } }
  return { from() { return q } }
}
const user = { activeLocation: { id: 'loc1' } }

describe('hyroxSessionsProvider', () => {
  it('has the right config', () => {
    expect(hyroxSessionsProvider.key).toBe('hyrox_sessions')
    expect(hyroxSessionsProvider.permissionKey).toBe('approvals_hyrox_sessions')
    expect(hyroxSessionsProvider.reviewBase).toBe('/admin/hyrox')
  })
  it('maps draft sessions to approval items', async () => {
    const db = fakeDb([{ id: 's1', week_no: 5, slot: 1, phase: 'build', focus: 'Engine', created_at: '2026-08-01T00:00:00Z' }])
    const { count, items } = await hyroxSessionsProvider.fetchPending(db, user)
    expect(count).toBe(1)
    expect(items[0]).toMatchObject({ id: 's1', reviewUrl: '/admin/hyrox?focus=s1' })
    expect(items[0].title).toContain('Week 5')
  })
  it('returns empty with no active location', async () => {
    const { count, items } = await hyroxSessionsProvider.fetchPending(fakeDb([]), {})
    expect(count).toBe(0); expect(items).toEqual([])
  })
})
