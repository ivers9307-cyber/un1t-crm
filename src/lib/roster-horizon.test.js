// ROSTER-FIX.5 — the nightly horizon sweep. Why it replaced the old lazy
// extend is in src/lib/roster-horizon.js.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('./roster', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, generateBlocksForTemplate: vi.fn() }
})

vi.mock('@/lib/shift-usual-coaches', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, readBlocksForFill: vi.fn(), fillUsualCoaches: vi.fn() }
})

import { extendRosterHorizon } from './roster-horizon'
import { generateBlocksForTemplate, getMonday, formatDate } from './roster'
import { readBlocksForFill, fillUsualCoaches } from '@/lib/shift-usual-coaches'
import { logWarn, logInfo } from '@/lib/log'

// Thenable select-builder: filters chain, awaiting resolves the envelope.
function templatesBuilder(result) {
  const b = {
    calls: [],
    select: (...a) => { b.calls.push(['select', ...a]); return b },
    eq: (...a) => { b.calls.push(['eq', ...a]); return b },
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  }
  return b
}

const TPL_A = { id: 't1', location_id: 'l1', start_time: '06:00', end_time: '07:00', days_of_week: ['mon'], max_coaches: 15 }
const TPL_B = { id: 't2', location_id: 'l2', start_time: '18:00', end_time: '19:00', days_of_week: ['tue', 'thu'], max_coaches: 10 }

let builder
function dbWith(result) {
  builder = templatesBuilder(result)
  return { from: vi.fn(() => builder) }
}

beforeEach(() => {
  vi.clearAllMocks()
  generateBlocksForTemplate.mockResolvedValue({ inserted: 3, skipped: 1 })
})

describe('extendRosterHorizon', () => {
  it('generates for every active template and totals what was inserted', async () => {
    const db = dbWith({ data: [TPL_A, TPL_B], error: null })
    const out = await extendRosterHorizon(db)

    expect(db.from).toHaveBeenCalledWith('shift_templates')
    expect(builder.calls).toContainEqual(['eq', 'active', true])
    expect(generateBlocksForTemplate).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ templates: 2, inserted: 6, failed: 0 })
  })

  // HORIZONMIN.1 — the generator reads template.min_coaches; a select that
  // leaves it off hands the generator undefined and every block falls to 1.
  it('selects min_coaches alongside max_coaches for the generator', async () => {
    const db = dbWith({ data: [TPL_A], error: null })
    await extendRosterHorizon(db)
    const sel = builder.calls.find((c) => c[0] === 'select')[1]
    expect(sel.split(',').map((c) => c.trim())).toEqual(expect.arrayContaining(['min_coaches', 'max_coaches']))
  })

  it('starts at this week\'s Monday and projects the requested weeks', async () => {
    const db = dbWith({ data: [TPL_A], error: null })
    await extendRosterHorizon(db, { weeks: 12 })
    const [, tpl, from, weeks] = generateBlocksForTemplate.mock.calls[0]
    expect(tpl).toBe(TPL_A)
    expect(formatDate(from)).toBe(formatDate(getMonday(new Date())))
    expect(weeks).toBe(12)
  })

  it('defaults to 8 weeks', async () => {
    const db = dbWith({ data: [TPL_A], error: null })
    await extendRosterHorizon(db)
    expect(generateBlocksForTemplate.mock.calls[0][3]).toBe(8)
  })

  // A template with no weekdays would generate nothing anyway; skipping it
  // here keeps the reported `templates` count honest.
  it('skips templates with no weekdays', async () => {
    const db = dbWith({ data: [TPL_A, { ...TPL_B, days_of_week: [] }, { ...TPL_B, id: 't3', days_of_week: null }], error: null })
    const out = await extendRosterHorizon(db)
    expect(generateBlocksForTemplate).toHaveBeenCalledTimes(1)
    expect(out.templates).toBe(1)
  })

  it('one broken template does not abandon the rest', async () => {
    generateBlocksForTemplate
      .mockRejectedValueOnce(new Error('unique violation'))
      .mockResolvedValueOnce({ inserted: 5, skipped: 0 })
    const db = dbWith({ data: [TPL_A, TPL_B], error: null })
    const out = await extendRosterHorizon(db)
    expect(out).toMatchObject({ templates: 2, inserted: 5, failed: 1 })
    expect(logWarn).toHaveBeenCalled()
  })

  it('throws when the template query errors — the cron must not report success', async () => {
    const db = dbWith({ data: null, error: { message: 'boom' } })
    await expect(extendRosterHorizon(db)).rejects.toThrow(/boom/)
  })

  // SLOTREMOVAL.1 — dates skipped for a deleted slot are totalled separately.
  it('totals the dates each template skipped for a deleted slot', async () => {
    generateBlocksForTemplate
      .mockResolvedValueOnce({ inserted: 2, skipped: 0, removed: 1 })
      .mockResolvedValueOnce({ inserted: 1, skipped: 0 })
    const db = dbWith({ data: [TPL_A, TPL_B], error: null })
    expect(await extendRosterHorizon(db)).toMatchObject({ inserted: 3, removed: 1, failed: 0 })
  })

  it('is a no-op when there are no active templates', async () => {
    const db = dbWith({ data: [], error: null })
    expect(await extendRosterHorizon(db)).toMatchObject({ templates: 0, inserted: 0, failed: 0 })
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
  })

  // USUALCOACH.1 — usual coaches go onto the blocks this run created, only.
  describe('usual coaches', () => {
    const WITH_USUAL = { ...TPL_A, usual_coach_ids: ['p1', 'p2'] }

    it('selects usual_coach_ids for the fill', async () => {
      const db = dbWith({ data: [TPL_A], error: null })
      await extendRosterHorizon(db)
      const sel = builder.calls.find((c) => c[0] === 'select')[1]
      expect(sel.split(',').map((c) => c.trim())).toContain('usual_coach_ids')
    })

    it('fills only the newly inserted blocks and totals the outcome, logging counts not names', async () => {
      generateBlocksForTemplate.mockResolvedValueOnce({ inserted: 2, skipped: 5, insertedIds: ['b-new-1', 'b-new-2'] })
      readBlocksForFill.mockResolvedValueOnce({ blocks: [{ id: 'b-new-1' }, { id: 'b-new-2' }], error: null })
      fillUsualCoaches.mockResolvedValueOnce({
        assigned: [{ block_id: 'b-new-1', profile_id: 'p1' }],
        skipped: [{ block_id: 'b-new-1', profile_id: 'p2', reason: 'time_off' }],
        counts: { time_off: 1 },
      })
      const db = dbWith({ data: [WITH_USUAL], error: null })
      const out = await extendRosterHorizon(db)
      expect(readBlocksForFill).toHaveBeenCalledWith(db, { blockIds: ['b-new-1', 'b-new-2'] })
      expect(fillUsualCoaches).toHaveBeenCalledWith(db, [{ id: 'b-new-1' }, { id: 'b-new-2' }], { actorId: null })
      expect(out).toMatchObject({ usualAssigned: 1, usualSkipped: 1, usualFillFailed: 0 })
      expect(logInfo).toHaveBeenCalledWith('roster-horizon', expect.any(String), expect.objectContaining({ counts: { time_off: 1 } }))
    })

    it('does nothing when no block is new, or the template has no usual coaches', async () => {
      generateBlocksForTemplate
        .mockResolvedValueOnce({ inserted: 0, skipped: 7, insertedIds: [] })
        .mockResolvedValueOnce({ inserted: 1, skipped: 0, insertedIds: ['b1'] })
      const db = dbWith({ data: [WITH_USUAL, TPL_B], error: null })
      await extendRosterHorizon(db)
      expect(readBlocksForFill).not.toHaveBeenCalled()
      expect(fillUsualCoaches).not.toHaveBeenCalled()
    })

    it('a failed fill never fails the sweep', async () => {
      generateBlocksForTemplate.mockResolvedValueOnce({ inserted: 1, skipped: 0, insertedIds: ['b1'] })
      readBlocksForFill.mockResolvedValueOnce({ blocks: [], error: { message: 'down' } })
      const db = dbWith({ data: [WITH_USUAL], error: null })
      const out = await extendRosterHorizon(db)
      expect(out).toMatchObject({ inserted: 1, failed: 0, usualFillFailed: 1 })
      expect(logWarn).toHaveBeenCalled()
    })
  })
})
