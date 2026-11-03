// REBOOK.1 — the Rebook timeline note.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({ logWarn: vi.fn() }))
vi.mock('./location-time.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getLocationZone: vi.fn().mockResolvedValue('Europe/Dublin') }
})

const { latestMissedBookingByContact, rebookNote, writeRebookNotes } = await import('./pipeline-rebook-notes.js')
const { logWarn } = await import('./log.js')

const NOW = Date.parse('2026-11-03T19:00:00Z')
const HATCH = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'

describe('latestMissedBookingByContact', () => {
  it('keeps the newest booking that ended without the class, per contact', () => {
    const m = latestMissedBookingByContact([
      { contact_id: 'a', class_name: 'OLD', starts_at: '2026-10-20T18:00:00Z', status: 'NO_SHOW' },
      { contact_id: 'a', class_name: 'RECLA1M', starts_at: '2026-11-03T18:00:00Z', status: 'CANCELLED' },
      { contact_id: 'b', class_name: 'GONE', starts_at: '2026-11-01T18:00:00Z', status: 'BOOKED' },
    ], NOW)
    expect(m.get('a').class_name).toBe('RECLA1M')
    expect(m.get('b').class_name).toBe('GONE')
  })
  it('skips an attended class and a live booking still to come', () => {
    const m = latestMissedBookingByContact([
      { contact_id: 'a', starts_at: '2026-11-01T18:00:00Z', status: 'ATTENDED', attended: true },
      { contact_id: 'a', starts_at: '2026-11-05T18:00:00Z', status: 'BOOKED' },
    ], NOW)
    expect(m.has('a')).toBe(false)
  })
})

describe('rebookNote', () => {
  it('names the class, the studio-local time and the outcome', () => {
    const n = rebookNote({ class_name: 'RECLA1M', starts_at: '2026-11-03T18:00:00Z', status: 'CANCELLED' }, 'Europe/Dublin')
    expect(n.subject).toBe('Pipeline: Rebook (booked RECLA1M, cancelled)')
    expect(n.note).toMatch(/^Booked RECLA1M on Tue 3 Nov at 18:00: cancelled\. Has not trained here yet\./)
    expect(n.note).not.toMatch(/[—–]/)
  })
  it('a past booking nothing was recorded for reads "not attended"', () => {
    expect(rebookNote({ class_name: null, starts_at: '2026-11-01T09:30:00Z', status: 'BOOKED' }, 'Europe/Dublin').subject)
      .toBe('Pipeline: Rebook (booked a class, not attended)')
  })
})

function fakeDb({ rows = [], readError = null, insertError = null } = {}) {
  const inserted = []
  const reads = []
  return {
    inserted,
    reads,
    from(table) {
      if (table === 'activities') {
        return { insert: (r) => { inserted.push(...r); return Promise.resolve({ error: insertError }) } }
      }
      const q = { table, filters: [] }
      const b = {
        select: (cols) => { q.cols = cols; return b },
        eq: (c, v) => { q.filters.push(['eq', c, v]); return b },
        in: (c, v) => { q.filters.push(['in', c, v]); reads.push(q); return Promise.resolve({ data: rows, error: readError }) },
      }
      return b
    },
  }
}

describe('writeRebookNotes', () => {
  beforeEach(() => vi.mocked(logWarn).mockClear())

  it('writes one event note per landed card, with its deal when it has one', async () => {
    const db = fakeDb({ rows: [
      { contact_id: 'c1', class_name: 'RECLA1M', starts_at: '2026-11-03T18:00:00Z', status: 'CANCELLED', attended: false },
      { contact_id: 'c2', class_name: 'RALLY', starts_at: '2026-11-01T09:00:00Z', status: 'NO_SHOW', attended: false },
    ] })
    const out = await writeRebookNotes(db, { locationId: HATCH, landed: [{ contact_id: 'c1', deal_id: 'd1' }, { contact_id: 'c2' }], nowMs: NOW })
    expect(out).toEqual({ written: 2 })
    expect(db.inserted).toEqual([
      expect.objectContaining({ kind: 'event', type: 'pipeline', contact_id: 'c1', deal_id: 'd1', done: true, location_id: HATCH }),
      expect.objectContaining({ kind: 'event', type: 'pipeline', contact_id: 'c2', done: true, location_id: HATCH }),
    ])
    expect(db.inserted[1]).not.toHaveProperty('deal_id')
    // Scoped to this studio's un1t.online bookings, named columns.
    expect(db.reads[0].table).toBe('class_bookings')
    expect(db.reads[0].filters).toEqual(expect.arrayContaining([['eq', 'location_id', HATCH], ['eq', 'source_platform', 'un1t_online']]))
    expect(db.reads[0].cols).toBe('contact_id, class_name, starts_at, status, attended')
  })

  it('a card with no missed booking on record gets no note', async () => {
    const db = fakeDb({ rows: [] })
    expect(await writeRebookNotes(db, { locationId: HATCH, landed: [{ contact_id: 'c1' }], nowMs: NOW })).toEqual({ written: 0 })
    expect(db.inserted).toHaveLength(0)
  })

  it('a failed read or insert is logged and never thrown', async () => {
    await expect(writeRebookNotes(fakeDb({ readError: { message: 'boom' } }), { locationId: HATCH, landed: [{ contact_id: 'c1' }], nowMs: NOW }))
      .resolves.toEqual({ written: 0 })
    expect(logWarn).toHaveBeenCalledWith('pipeline-reclassify', 'rebook note write failed', expect.objectContaining({ locationId: HATCH }))
    const db = fakeDb({ rows: [{ contact_id: 'c1', starts_at: '2026-11-03T18:00:00Z', status: 'CANCELLED' }], insertError: { message: 'nope' } })
    await expect(writeRebookNotes(db, { locationId: HATCH, landed: [{ contact_id: 'c1' }], nowMs: NOW })).resolves.toEqual({ written: 0 })
  })

  it('nothing landed: no reads', async () => {
    const db = fakeDb()
    expect(await writeRebookNotes(db, { locationId: HATCH, landed: [] })).toEqual({ written: 0 })
    expect(db.reads).toHaveLength(0)
  })
})
