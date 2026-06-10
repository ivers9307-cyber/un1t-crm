// src/lib/whatsapp-audience.test.js
import { describe, it, expect } from 'vitest'
import { fetchAllWhatsAppAudience, fetchDripDoneContactIds } from './whatsapp.js'

// Fluent fake whose terminal .range() resolves to the next configured page. Every
// other method returns the builder so buildWhatsAppAudience's chain + applyAudienceFilter
// compose without error.
function fakeAudienceDb(pages) {
  let i = 0
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === 'range') return () => Promise.resolve({ data: pages[i++] ?? [], error: null })
      if (prop === 'then') return undefined // builder itself is not awaited
      return () => builder
    },
  })
  return { from: () => builder }
}

describe('fetchAllWhatsAppAudience', () => {
  it('returns a single short page without paging again', async () => {
    const db = fakeAudienceDb([[{ id: 'a' }, { id: 'b' }]])
    const rows = await fetchAllWhatsAppAudience(db, { logic: 'and', filters: [] }, 'loc')
    expect(rows.map(r => r.id)).toEqual(['a', 'b'])
  })
  it('pages until a short page ends the loop', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `p1-${i}` }))
    const db = fakeAudienceDb([full, [{ id: 'p2-0' }]]) // 1000 then 1 → stop after page 2
    const rows = await fetchAllWhatsAppAudience(db, { logic: 'and', filters: [] }, 'loc')
    expect(rows).toHaveLength(1001)
    expect(rows[1000].id).toBe('p2-0')
  })
})

describe('fetchDripDoneContactIds', () => {
  function fakeRecipientsDb(pages) {
    let i = 0
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'range') return () => Promise.resolve({ data: pages[i++] ?? [], error: null })
        if (prop === 'then') return undefined
        return () => builder
      },
    })
    return { from: () => builder }
  }
  it('flattens contact_id across pages and drops nulls', async () => {
    const db = fakeRecipientsDb([[{ contact_id: 'x' }, { contact_id: null }, { contact_id: 'y' }]])
    const ids = await fetchDripDoneContactIds(db, 'b1')
    expect(ids).toEqual(['x', 'y'])
  })
})
