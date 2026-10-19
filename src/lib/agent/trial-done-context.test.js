// TRIALDONE.6 — Mia's trial-done context line (trial-done-context.js).
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

import { logWarn } from '@/lib/log'
import { trialDoneLineFor } from './trial-done-context'
import { DEFAULTS } from './settings-contract'

const LOC = '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4'
const CONTACT = 'c0000000-0000-4000-8000-000000000001'
const NOW = Date.parse('2026-10-19T12:00:00Z')
const HOUR = 3600 * 1000

// A one-table fake: records the chain, answers maybeSingle with `result`.
function fakeDb(result) {
  const calls = { from: null, select: null, eq: [] }
  const chain = {
    select(cols) { calls.select = cols; return chain },
    eq(col, val) { calls.eq.push([col, val]); return chain },
    maybeSingle: vi.fn(async () => (typeof result === 'function' ? result() : result)),
  }
  return {
    calls,
    from(table) { calls.from = table; return chain },
  }
}

const row = (over = {}) => ({
  trigger_at: '2026-10-17T10:00:00Z',
  opener_sent_at: '2026-10-17T12:00:00Z',
  closed_reason: null,
  ...over,
})

const args = (over = {}) => ({
  locationId: LOC,
  contactId: CONTACT,
  nowMs: NOW,
  settings: { trial_done: { enabled: true } },
  studioName: 'Hatch Street',
  zone: 'Europe/Dublin',
  ...over,
})

describe('trialDoneLineFor', () => {
  beforeEach(() => { vi.mocked(logWarn).mockClear() })

  it('returns the instruction with studio and date filled', async () => {
    const db = fakeDb({ data: row(), error: null })
    const line = await trialDoneLineFor(db, args())
    expect(line).toBe(DEFAULTS.trial_done.mia_instruction
      .replace('{studio}', 'Hatch Street')
      .replace('{date}', 'Saturday 17 October'))
    expect(line).toContain('finished their trial at Hatch Street on Saturday 17 October')
    expect(line).not.toMatch(/[{}—]/)
    expect(db.calls.from).toBe('trial_done_outreach')
    expect(db.calls.eq).toEqual([['location_id', LOC], ['contact_id', CONTACT]])
  })

  it('reads the date in the studio zone, not UTC', async () => {
    // 23:30 UTC on the 17th is 00:30 on Sunday the 18th in Dublin (IST).
    const db = fakeDb({ data: row({ trigger_at: '2026-10-17T23:30:00Z' }), error: null })
    expect(await trialDoneLineFor(db, args())).toContain('on Sunday 18 October')
  })

  it("uses the studio's own instruction when it set one", async () => {
    const db = fakeDb({ data: row(), error: null })
    const line = await trialDoneLineFor(db, args({ settings: { trial_done: { enabled: true, mia_instruction: 'At {studio}, trial ended {date}. {studio} again.' } } }))
    expect(line).toBe('At Hatch Street, trial ended Saturday 17 October. Hatch Street again.')
  })

  it('null after 7 days', async () => {
    const sent = NOW - 7 * 24 * HOUR - 1000
    const db = fakeDb({ data: row({ opener_sent_at: new Date(sent).toISOString() }), error: null })
    expect(await trialDoneLineFor(db, args())).toBeNull()
    // just inside the window still counts
    const inside = fakeDb({ data: row({ opener_sent_at: new Date(NOW - 7 * 24 * HOUR + 60_000).toISOString() }), error: null })
    expect(await trialDoneLineFor(inside, args())).not.toBeNull()
  })

  it('null when the opener was never sent', async () => {
    const db = fakeDb({ data: row({ opener_sent_at: null }), error: null })
    expect(await trialDoneLineFor(db, args())).toBeNull()
  })

  it('null when there is no row', async () => {
    expect(await trialDoneLineFor(fakeDb({ data: null, error: null }), args())).toBeNull()
  })

  it('null when closed purchased', async () => {
    const db = fakeDb({ data: row({ closed_reason: 'purchased' }), error: null })
    expect(await trialDoneLineFor(db, args())).toBeNull()
  })

  it('null when closed opted_out', async () => {
    const db = fakeDb({ data: row({ closed_reason: 'opted_out' }), error: null })
    expect(await trialDoneLineFor(db, args())).toBeNull()
  })

  it('a row closed for another reason still gets the line', async () => {
    const db = fakeDb({ data: row({ closed_reason: 'no_reply' }), error: null })
    expect(await trialDoneLineFor(db, args())).toContain('Hatch Street')
  })

  it('null and no throw when the read fails', async () => {
    const db = fakeDb({ data: null, error: { message: 'boom', code: '42P01' } })
    await expect(trialDoneLineFor(db, args())).resolves.toBeNull()
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('null and no throw when the client throws', async () => {
    const db = fakeDb(() => { throw new Error('network') })
    await expect(trialDoneLineFor(db, args())).resolves.toBeNull()
    expect(logWarn).toHaveBeenCalledTimes(1)
  })

  it('null without a location or a contact (no read)', async () => {
    const db = fakeDb({ data: row(), error: null })
    expect(await trialDoneLineFor(db, args({ contactId: null }))).toBeNull()
    expect(await trialDoneLineFor(db, args({ locationId: null }))).toBeNull()
    expect(db.calls.from).toBeNull()
  })
})
