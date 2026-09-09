// ROSTER-FIX.5 — the nightly horizon sweep.
//
// The horizon used to be extended lazily, only when an operator scrolled the
// calendar past 8 weeks. Nothing scrolls on a coach's phone, so a week that
// nobody had browsed to simply had no blocks in it — invisible until someone
// noticed the roster was empty. This sweep keeps N weeks materialised for
// every active template whether or not anyone looks.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('./roster', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, generateBlocksForTemplate: vi.fn() }
})

import { extendRosterHorizon } from './roster-horizon'
import { generateBlocksForTemplate, getMonday, formatDate } from './roster'
import { logWarn } from '@/lib/log'

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

  it('is a no-op when there are no active templates', async () => {
    const db = dbWith({ data: [], error: null })
    expect(await extendRosterHorizon(db)).toMatchObject({ templates: 0, inserted: 0, failed: 0 })
    expect(generateBlocksForTemplate).not.toHaveBeenCalled()
  })
})
