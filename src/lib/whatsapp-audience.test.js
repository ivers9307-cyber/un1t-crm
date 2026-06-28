// src/lib/whatsapp-audience.test.js
import { describe, it, expect } from 'vitest'
import { fetchAllWhatsAppAudience, fetchDripDoneContactIds, buildWhatsAppAudienceAsync } from './whatsapp.js'

// Call-recording fluent fake (mirrors sms.test.js) — every method returns the
// same builder so chains compose; `calls` captures method + args for gate
// assertions. No `then`, so the builder itself is never awaited.
function makeFakeQuery() {
  const calls = []
  const builder = new Proxy({}, {
    get(_, method) {
      if (method === 'then') return undefined
      return (...args) => { calls.push({ method, args }); return builder }
    },
  })
  return { builder, calls }
}

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

describe('buildWhatsAppAudienceAsync', () => {
  it('returns a wrapped { query }', async () => {
    const { builder } = makeFakeQuery()
    const db = { from: () => builder }
    const result = await buildWhatsAppAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    expect(result).toHaveProperty('query')
    expect(result.query).toBeDefined()
  })

  it('applies the WhatsApp eligibility gates (single-table, post mig 325)', async () => {
    const { builder, calls } = makeFakeQuery()
    const db = { from: (t) => { calls.push({ method: 'from', args: [t] }); return builder } }
    await buildWhatsAppAudienceAsync(db, { logic: 'and', filters: [] }, 'loc-uuid')
    // Gate now reads the denormalized contacts.whatsapp_marketing — no contact_preferences embed.
    expect(calls).toContainEqual({ method: 'eq', args: ['whatsapp_marketing', true] })
    expect(calls).toContainEqual({ method: 'not', args: ['wa_phone', 'is', null] })
    expect(calls).toContainEqual({ method: 'neq', args: ['wa_status', 'blocked'] })
    expect(calls).toContainEqual({ method: 'neq', args: ['wa_status', 'opted_out'] })
    expect(calls).toContainEqual({ method: 'neq', args: ['wa_status', 'undeliverable'] })
    // The old embedded-join gate is gone.
    expect(calls).not.toContainEqual({ method: 'eq', args: ['contact_preferences.whatsapp_marketing', true] })
  })
})
