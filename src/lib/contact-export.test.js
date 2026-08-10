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

// DSAR-CONSENT.1 — the bundle read consent_log.action straight off the row
// without going through normaliseConsentAction, so a bundle built from data
// written before mig 516 (or restored from an older dump) shows two spellings
// of one fact: `opted_out` next to `opt_out`.
function exportDb(rowsByTable) {
  function builder(table) {
    const state = { table, from: 0, to: 0 }
    const b = {
      select: () => b,
      eq: () => b,
      order: () => b,
      range: (from, to) => { state.from = from; state.to = to; return b },
      then(resolve) {
        const all = rowsByTable[table] || []
        resolve({ data: all.slice(state.from, state.to + 1), error: null })
      },
    }
    return b
  }
  return { from: (table) => builder(table) }
}

const CONTACT = { id: 'c1', name: 'Alice M', email: 'a@x.ie', phone: null, created_at: '2026-01-01T00:00:00.000Z', location_id: 'loc-1' }

describe('buildContactExport — consent_log action vocabulary (DSAR-CONSENT.1)', () => {
  it('renders one spelling of each fact, and keeps the stored value visible', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const db = exportDb({
      consent_log: [
        { channel: 'email_marketing', action: 'opted_out', source: 'whatsapp_stop', created_at: '2026-02-01T00:00:00.000Z' },
        { channel: 'sms_marketing', action: 'opt_out', source: 'preference_centre', created_at: '2026-03-01T00:00:00.000Z' },
        { channel: 'email_marketing', action: 'opted_in', source: 'booking_form', created_at: '2026-04-01T00:00:00.000Z' },
      ],
    })

    const bundle = await buildContactExport(db, CONTACT)
    const rows = bundle.sections.consent_log.rows

    expect(rows.map((r) => r.action)).toEqual(['opt_out', 'opt_out', 'opt_in'])
    // Non-lossy: where the stored value differed it is still in the bundle.
    expect(rows[0].action_raw).toBe('opted_out')
    expect(rows[2].action_raw).toBe('opted_in')
    // Where it did not differ, no redundant field is emitted.
    expect(rows[1]).not.toHaveProperty('action_raw')
  })

  it('passes an unrecognised action through verbatim rather than guessing', async () => {
    const { buildContactExport } = await import('./contact-export.js')
    const db = exportDb({
      consent_log: [{ channel: 'email_marketing', action: 'who_knows', source: 'legacy', created_at: '2026-02-01T00:00:00.000Z' }],
    })

    const bundle = await buildContactExport(db, CONTACT)
    const [row] = bundle.sections.consent_log.rows
    expect(row.action).toBe('who_knows')
    expect(row).not.toHaveProperty('action_raw')
  })
})
