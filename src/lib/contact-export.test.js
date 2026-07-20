import { describe, it, expect, vi } from 'vitest'
import { fetchAllRows, MAX_ROWS_PER_SECTION } from './contact-export.js'

function pagedDb(totalRows) {
  // A stub whose .range(from, to) slices a synthetic row set, mimicking
  // PostgREST's paging so the paginator's loop logic is exercised for real.
  const all = Array.from({ length: totalRows }, (_, i) => ({ id: `r${i}` }))
  const builder = {
    _from: 0,
    _to: 0,
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    range: vi.fn((from, to) => {
      builder._from = from
      builder._to = to
      return builder
    }),
    then(resolve) {
      resolve({ data: all.slice(builder._from, builder._to + 1), error: null })
    },
  }
  return { from: vi.fn(() => builder), builder }
}

describe('fetchAllRows (SAAS4-C3 — DSAR export paginator)', () => {
  it('collects every row across pages (beyond the PostgREST 1k cap)', async () => {
    const db = pagedDb(2500)
    const { rows, truncated } = await fetchAllRows(db, {
      table: 'email_sends',
      select: 'id',
      eq: { contact_id: 'c1' },
      orderCol: 'id',
    })
    expect(rows).toHaveLength(2500)
    expect(truncated).toBe(false)
  })

  it('stops at MAX_ROWS_PER_SECTION and flags truncation honestly', async () => {
    const db = pagedDb(MAX_ROWS_PER_SECTION + 500)
    const { rows, truncated } = await fetchAllRows(db, {
      table: 'whatsapp_messages',
      select: 'id',
      eq: { conversation_id: 'w1' },
      orderCol: 'id',
    })
    expect(rows).toHaveLength(MAX_ROWS_PER_SECTION)
    expect(truncated).toBe(true)
  })

  it('throws on a PostgREST error instead of reading it as "no rows" — a DSAR must never silently omit a section', async () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      range: () => builder,
      then(resolve) {
        resolve({ data: null, error: { message: 'column does not exist' } })
      },
    }
    const db = { from: () => builder }
    await expect(
      fetchAllRows(db, { table: 'x', select: 'nope', eq: { contact_id: 'c1' }, orderCol: 'id' })
    ).rejects.toThrow(/column does not exist/)
  })

  it('returns empty cleanly for a contact with no rows', async () => {
    const db = pagedDb(0)
    const { rows, truncated } = await fetchAllRows(db, {
      table: 'notes',
      select: 'id',
      eq: { contact_id: 'c1' },
      orderCol: 'id',
    })
    expect(rows).toEqual([])
    expect(truncated).toBe(false)
  })
})
