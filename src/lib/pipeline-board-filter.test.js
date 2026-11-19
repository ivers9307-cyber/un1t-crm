// BOARDFILTER.1 — the board's search and "stuck" filter.
import { describe, it, expect } from 'vitest'
import { parseBoardFilter, boardFilterActive, boardFilterParams, applyBoardFilter, BOARD_SEARCH_MAX, keepNotContacted } from './pipeline-board-filter.js'
import { dealAge, STALE_DAYS, PIPELINE_BACKFILL_CUTOFF } from './pipeline-board.js'

const NOW = Date.parse('2026-11-16T12:00:00Z')
const DAY = 86_400_000

// Records the calls applyBoardFilter makes.
function recorder() {
  const calls = []
  const q = { ilike: (c, v) => { calls.push(['ilike', c, v]); return q }, or: (v) => { calls.push(['or', v]); return q } }
  return { q, calls }
}

describe('parseBoardFilter', () => {
  it('reads a plain object or URLSearchParams; trims and squashes spaces', () => {
    expect(parseBoardFilter({ q: '  Aoife   Byrne ', stuck: '1' })).toEqual({ q: 'Aoife Byrne', stuck: true, nocontact: false })
    expect(parseBoardFilter(new URLSearchParams('q=pat&stuck=1'))).toEqual({ q: 'pat', stuck: true, nocontact: false })
  })
  it('anything else is no filter, so an old bookmark is unchanged', () => {
    for (const sp of [null, {}, { q: '' }, { q: '   ' }, { q: ['a'] }, { stuck: 'yes' }, { stuck: '0' }, { nocontact: '0' }, { nocontact: 'true' }]) {
      expect(boardFilterActive(parseBoardFilter(sp))).toBe(false)
    }
  })
  it('stuck is dropped on the Off funnel view; the search is kept', () => {
    expect(parseBoardFilter({ q: 'pat', stuck: '1' }, { view: 'dormant' })).toEqual({ q: 'pat', stuck: false, nocontact: false })
    expect(parseBoardFilter({ stuck: '1' }, { view: 'active' }).stuck).toBe(true)
  })
  it('CONTACTLOG.1 — ?nocontact=1 is Not contacted, on the Funnel view only', () => {
    expect(parseBoardFilter(new URLSearchParams('nocontact=1'))).toEqual({ q: null, stuck: false, nocontact: true })
    expect(boardFilterActive(parseBoardFilter({ nocontact: '1' }))).toBe(true)
    expect(parseBoardFilter({ nocontact: '1' }, { view: 'dormant' }).nocontact).toBe(false)
    expect(boardFilterParams({ q: null, stuck: false, nocontact: true }).toString()).toBe('nocontact=1')
  })
  it('a long term is cut, not refused', () => {
    expect(parseBoardFilter({ q: 'x'.repeat(500) }).q).toHaveLength(BOARD_SEARCH_MAX)
  })
})

describe('boardFilterParams', () => {
  it('only what is set', () => {
    expect(boardFilterParams({ q: null, stuck: false }).toString()).toBe('')
    expect(boardFilterParams({ q: 'a b', stuck: true }).toString()).toBe('q=a+b&stuck=1')
  })
})

describe('applyBoardFilter', () => {
  it('no filter: the query untouched', () => {
    const { q, calls } = recorder()
    expect(applyBoardFilter(q, { q: null, stuck: false }, NOW)).toBe(q)
    expect(calls).toEqual([])
  })
  it('search: a substring of the title with the term escaped, so % and _ match literally', () => {
    const { q, calls } = recorder()
    applyBoardFilter(q, { q: '50%_off', stuck: false }, NOW)
    expect(calls).toEqual([['ilike', 'title', '%50\\%\\_off%']])
  })
  it('stuck: 21+ days in the stage, or in the pipeline when unstamped and not backfilled', () => {
    const { q, calls } = recorder()
    applyBoardFilter(q, { q: null, stuck: true }, NOW)
    const cutoff = new Date(NOW - STALE_DAYS * DAY).toISOString()
    expect(calls).toEqual([['or', `stage_entered_at.lte.${cutoff},and(stage_entered_at.is.null,created_at.lte.${cutoff},created_at.gte.${PIPELINE_BACKFILL_CUTOFF})`]])
  })
  it('stuck matches the red age footer at its edges (dealAge)', () => {
    const at = (days) => new Date(NOW - days * DAY).toISOString()
    expect(dealAge({ stage_entered_at: at(STALE_DAYS), created_at: at(40) }, NOW).tone).toBe('stale')
    expect(dealAge({ stage_entered_at: at(STALE_DAYS - 0.01), created_at: at(40) }, NOW).tone).not.toBe('stale')
    expect(dealAge({ stage_entered_at: null, created_at: '2026-05-01T00:00:00Z' }, NOW).tone).toBe('quiet')   // backfilled: never alarms
  })
})

describe('keepNotContacted (CONTACTLOG.1)', () => {
  it('drops a card whose contact was contacted, and a card with no contact', () => {
    const rows = [
      { id: 'd1', contacts: { id: 'c1' } },
      { id: 'd2', contacts: { id: 'c2' } },
      { id: 'd3', contacts: null },
    ]
    expect(keepNotContacted(rows, new Set(['c1'])).map((d) => d.id)).toEqual(['d2'])
    expect(keepNotContacted(rows, new Set()).map((d) => d.id)).toEqual(['d1', 'd2'])
  })
})
