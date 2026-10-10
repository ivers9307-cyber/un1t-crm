// EVENT-MOVE.6/.7 — a customer's move stays inside the entry's organisation.
import { describe, it, expect } from 'vitest'
import { moveLocationIds } from './move-locations.js'

function db({ org = { data: { organization_id: 'O1' }, error: null }, rows = { data: [{ id: 'L1' }, { id: 'L2' }], error: null } } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const n of ['select', 'eq', 'order', 'limit']) b[n] = (...a) => { q.ops.push([n, ...a]); return b }
      b.maybeSingle = async () => org
      b.then = (res, rej) => Promise.resolve(rows).then(res, rej)
      return b
    },
  }
}

describe('moveLocationIds', () => {
  it('every studio of the organisation it reads', async () => {
    const d = db()
    expect(await moveLocationIds(d, 'L1')).toEqual(['L1', 'L2'])
    expect(d.calls[1].ops).toContainEqual(['eq', 'organization_id', 'O1'])
  })
  it('uses an organisation the caller already has, without reading the studio', async () => {
    const d = db()
    expect(await moveLocationIds(d, 'L1', { organizationId: 'O1' })).toEqual(['L1', 'L2'])
    expect(d.calls).toHaveLength(1)
  })
  it('no organisation: the studio alone', async () => {
    expect(await moveLocationIds(db(), 'L1', { organizationId: null })).toEqual(['L1'])
    expect(await moveLocationIds(db({ org: { data: { organization_id: null }, error: null } }), 'L1')).toEqual(['L1'])
  })
  it('keeps the studio itself even when the org list misses it', async () => {
    expect(await moveLocationIds(db({ rows: { data: [{ id: 'L2' }], error: null } }), 'L1')).toEqual(['L1', 'L2'])
  })
  it('null (fail closed) when either read fails, or there is no studio', async () => {
    expect(await moveLocationIds(db({ org: { data: null, error: { message: 'down' } } }), 'L1')).toBeNull()
    expect(await moveLocationIds(db({ rows: { data: null, error: { message: 'down' } } }), 'L1', { organizationId: 'O1' })).toBeNull()
    expect(await moveLocationIds(db(), null)).toBeNull()
  })
})
