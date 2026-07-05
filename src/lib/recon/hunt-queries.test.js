// RCOV.P1 — hunt query builder test coverage.
//
// Pure module: no mocking needed. addDaysISO (@/lib/dublin-time) is
// confirmed pure UTC date-string math (no Date.now()/TZ dependency),
// so these tests run the real implementation end to end.

import { describe, it, expect } from 'vitest'
import { counterpartyTokens, gmailDate, amountVariants, buildHuntQueries } from './hunt-queries'

describe('counterpartyTokens', () => {
  it('strips noise words and digits, keeps informative tokens', () => {
    expect(counterpartyTokens('MUSCLEFOOD LTD CARD 1234')).toEqual(['MUSCLEFOOD'])
  })

  it('keeps multiple informative tokens in order', () => {
    expect(counterpartyTokens('ELECTRIC IRELAND DD 8871')).toEqual(['ELECTRIC', 'IRELAND'])
  })

  it('returns [] for empty or null description', () => {
    expect(counterpartyTokens('')).toEqual([])
    expect(counterpartyTokens(null)).toEqual([])
    expect(counterpartyTokens(undefined)).toEqual([])
  })

  it('caps at 3 tokens when more than 3 are informative', () => {
    const tokens = counterpartyTokens('ALPHA BETA GAMMA DELTA EPSILON')
    expect(tokens).toHaveLength(3)
    expect(tokens).toEqual(['ALPHA', 'BETA', 'GAMMA'])
  })
})

describe('gmailDate', () => {
  it('converts YYYY-MM-DD to YYYY/MM/DD', () => {
    expect(gmailDate('2026-06-03')).toBe('2026/06/03')
  })

  it('tolerates a full ISO timestamp input', () => {
    expect(gmailDate('2026-06-03T00:00:00')).toBe('2026/06/03')
  })
})

describe('amountVariants', () => {
  it('returns absolute, 2dp, quoted dot and comma variants', () => {
    expect(amountVariants(-84.5)).toEqual(['"84.50"', '"84,50"'])
  })
})

describe('buildHuntQueries', () => {
  const line = { line_date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD CARD 1234' }

  it('returns exactly 3 queries for a description with an informative token', () => {
    const queries = buildHuntQueries(line)
    expect(queries).toHaveLength(3)
  })

  it('q1 is the tight amount+window+attachment query (±45d default)', () => {
    const [q1] = buildHuntQueries(line)
    // Independently verified: addDaysISO('2026-06-03', -45) === '2026-04-19',
    // addDaysISO('2026-06-03', 45) === '2026-07-18'.
    expect(q1).toBe('"84.50" after:2026/04/19 before:2026/07/18 has:attachment')
  })

  it('q2 is the counterparty-token query, same window + has:attachment', () => {
    const [, q2] = buildHuntQueries(line)
    expect(q2.startsWith('MUSCLEFOOD ')).toBe(true)
    expect(q2).toContain('after:2026/04/19 before:2026/07/18')
    expect(q2).toContain('has:attachment')
  })

  it('q3 is q1 without has:attachment (body-amount fallback)', () => {
    const [q1, , q3] = buildHuntQueries(line)
    expect(q3).toBe(q1.replace(' has:attachment', ''))
  })

  it('omits the token query when the description has no informative tokens', () => {
    const noTokenLine = { line_date: '2026-06-03', amount: -84.5, description: 'DD 12345' }
    const queries = buildHuntQueries(noTokenLine)
    expect(queries).toHaveLength(2)
  })

  it('respects a windowDays override', () => {
    const [q1] = buildHuntQueries(line, 10)
    // Independently verified: addDaysISO('2026-06-03', -10) === '2026-05-24',
    // addDaysISO('2026-06-03', 10) === '2026-06-13'.
    expect(q1).toBe('"84.50" after:2026/05/24 before:2026/06/13 has:attachment')
  })
})
