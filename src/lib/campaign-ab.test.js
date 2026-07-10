// CAMPAIGN-AB (COMMS-AUDIT 2026-07-10) — subject-line A/B testing v1.
//
// Pure-helper tests for the phase machine + winner decision:
//
//   1. resolveAbPhase — column-driven phase machine (off / slice /
//      waiting / decide / final). No new campaigns.status values;
//      overlapping cron ticks each derive the same phase from the row.
//   2. assignAbVariants — deterministic populate-time slice assignment
//      (hash-ordered so it's independent of audience load order),
//      half A / half B, pct-bounded, tiny audiences get no test.
//   3. decideAbWinner — open rate per variant; strict-greater B wins,
//      ties and zero-open/zero-send data go to A.
//   4. subjectForVariant — per-recipient subject resolution, including
//      the remainder (winner's subject) and the off/default path.

import { describe, it, expect } from 'vitest'
import {
  resolveAbPhase,
  assignAbVariants,
  decideAbWinner,
  subjectForVariant,
  clampAbTestPct,
  clampAbWaitHours,
  AB_TEST_PCT_DEFAULT,
  AB_WAIT_HOURS_DEFAULT,
  AB_MIN_AUDIENCE,
} from './campaign-ab.js'

const HOUR = 3600_000

const abCampaign = (overrides = {}) => ({
  id: 'camp-1',
  subject: 'Subject A',
  ab_subject_b: 'Subject B',
  ab_test_pct: 10,
  ab_wait_hours: 4,
  ab_winner: null,
  ab_test_started_at: null,
  ab_decided_at: null,
  ...overrides,
})

describe('resolveAbPhase', () => {
  const now = Date.parse('2026-07-10T12:00:00Z')

  it('is off when ab_subject_b is not set (default path)', () => {
    expect(resolveAbPhase(abCampaign({ ab_subject_b: null }), now)).toBe('off')
    expect(resolveAbPhase(abCampaign({ ab_subject_b: '' }), now)).toBe('off')
    expect(resolveAbPhase({ id: 'c', subject: 'S' }, now)).toBe('off')
  })

  it('is slice while the test slice has not finished (no ab_test_started_at)', () => {
    expect(resolveAbPhase(abCampaign(), now)).toBe('slice')
  })

  it('is waiting inside the wait window', () => {
    const started = new Date(now - 1 * HOUR).toISOString()
    expect(resolveAbPhase(abCampaign({ ab_test_started_at: started }), now)).toBe('waiting')
  })

  it('is decide once the wait has elapsed and no winner is stamped', () => {
    const started = new Date(now - 5 * HOUR).toISOString()
    expect(resolveAbPhase(abCampaign({ ab_test_started_at: started }), now)).toBe('decide')
  })

  it('is final once a winner is stamped (regardless of clocks)', () => {
    expect(resolveAbPhase(abCampaign({
      ab_test_started_at: new Date(now - 1 * HOUR).toISOString(),
      ab_winner: 'b',
    }), now)).toBe('final')
  })

  it('clamps a missing/out-of-bounds wait to the default so a bad row cannot wait forever', () => {
    const started = new Date(now - (AB_WAIT_HOURS_DEFAULT + 1) * HOUR).toISOString()
    expect(resolveAbPhase(abCampaign({ ab_test_started_at: started, ab_wait_hours: null }), now)).toBe('decide')
    expect(resolveAbPhase(abCampaign({ ab_test_started_at: started, ab_wait_hours: 9999 }), now)).toBe('waiting')
  })
})

describe('clampAbTestPct / clampAbWaitHours', () => {
  it('defaults and clamps the test percentage to 5-50', () => {
    expect(clampAbTestPct(null)).toBe(AB_TEST_PCT_DEFAULT)
    expect(clampAbTestPct(undefined)).toBe(AB_TEST_PCT_DEFAULT)
    expect(clampAbTestPct(10)).toBe(10)
    expect(clampAbTestPct(1)).toBe(5)
    expect(clampAbTestPct(90)).toBe(50)
    expect(clampAbTestPct('nonsense')).toBe(AB_TEST_PCT_DEFAULT)
  })

  it('defaults and clamps the wait to 1-24 hours', () => {
    expect(clampAbWaitHours(null)).toBe(AB_WAIT_HOURS_DEFAULT)
    expect(clampAbWaitHours(4)).toBe(4)
    expect(clampAbWaitHours(0)).toBe(1)
    expect(clampAbWaitHours(100)).toBe(24)
    expect(clampAbWaitHours('nonsense')).toBe(AB_WAIT_HOURS_DEFAULT)
  })
})

describe('assignAbVariants', () => {
  const ids = (n) => Array.from({ length: n }, (_, i) => `contact-${i + 1}`)

  it('is deterministic — same ids give the same assignment regardless of input order', () => {
    const forward = assignAbVariants(ids(100), 10)
    const reversed = assignAbVariants([...ids(100)].reverse(), 10)
    expect(forward.size).toBe(reversed.size)
    for (const [id, v] of forward) expect(reversed.get(id)).toBe(v)
  })

  it('assigns ~pct% of the audience, split half A / half B', () => {
    const map = assignAbVariants(ids(1000), 10)
    expect(map.size).toBe(100)
    const a = [...map.values()].filter(v => v === 'a').length
    const b = [...map.values()].filter(v => v === 'b').length
    expect(a).toBe(50)
    expect(b).toBe(50)
  })

  it('an odd slice differs by at most one between variants', () => {
    const map = assignAbVariants(ids(90), 10) // slice of 9
    const a = [...map.values()].filter(v => v === 'a').length
    const b = [...map.values()].filter(v => v === 'b').length
    expect(a + b).toBe(9)
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1)
  })

  it('slice always has at least one of each variant and leaves a remainder', () => {
    const map = assignAbVariants(ids(AB_MIN_AUDIENCE), 5)
    const values = [...map.values()]
    expect(values).toContain('a')
    expect(values).toContain('b')
    expect(map.size).toBeLessThan(AB_MIN_AUDIENCE) // remainder non-empty
  })

  it('returns an empty assignment for audiences too small to test', () => {
    expect(assignAbVariants(ids(AB_MIN_AUDIENCE - 1), 50).size).toBe(0)
    expect(assignAbVariants([], 10).size).toBe(0)
  })

  it('never assigns the whole audience even at pct 50 (remainder must exist)', () => {
    const map = assignAbVariants(ids(4), 50)
    expect(map.size).toBeLessThan(4)
  })

  it('only assigns a|b', () => {
    const map = assignAbVariants(ids(200), 25)
    for (const v of map.values()) expect(['a', 'b']).toContain(v)
  })
})

describe('decideAbWinner', () => {
  const rows = (a, b) => ([
    { ab_variant: 'a', sent_count: a.sent, opened_count: a.opened },
    { ab_variant: 'b', sent_count: b.sent, opened_count: b.opened },
  ])

  it('picks B when its open rate is strictly higher', () => {
    expect(decideAbWinner(rows({ sent: 50, opened: 10 }, { sent: 50, opened: 20 }))).toBe('b')
  })

  it('picks A when its open rate is higher', () => {
    expect(decideAbWinner(rows({ sent: 50, opened: 25 }, { sent: 50, opened: 20 }))).toBe('a')
  })

  it('open RATE not raw count — fewer sends with higher rate wins', () => {
    // A: 10/40 = 25%; B: 12/30 = 40% — B wins despite similar counts.
    expect(decideAbWinner(rows({ sent: 40, opened: 10 }, { sent: 30, opened: 12 }))).toBe('b')
  })

  it('tie goes to A', () => {
    expect(decideAbWinner(rows({ sent: 50, opened: 10 }, { sent: 50, opened: 10 }))).toBe('a')
  })

  it('zero opens on both sides goes to A', () => {
    expect(decideAbWinner(rows({ sent: 50, opened: 0 }, { sent: 50, opened: 0 }))).toBe('a')
  })

  it('zero sends (rate undefined) counts as rate 0 — B with no sends cannot win', () => {
    expect(decideAbWinner(rows({ sent: 50, opened: 5 }, { sent: 0, opened: 0 }))).toBe('a')
    expect(decideAbWinner(rows({ sent: 0, opened: 0 }, { sent: 0, opened: 0 }))).toBe('a')
  })

  it('missing/empty stats rows go to A', () => {
    expect(decideAbWinner([])).toBe('a')
    expect(decideAbWinner(null)).toBe('a')
    expect(decideAbWinner([{ ab_variant: 'b', sent_count: 10, opened_count: 5 }])).toBe('b')
    expect(decideAbWinner([{ ab_variant: 'b', sent_count: 10, opened_count: 0 }])).toBe('a')
  })

  it('handles string counts (PostgREST returns BIGINT as string in some paths)', () => {
    expect(decideAbWinner([
      { ab_variant: 'a', sent_count: '50', opened_count: '5' },
      { ab_variant: 'b', sent_count: '50', opened_count: '15' },
    ])).toBe('b')
  })
})

describe('subjectForVariant', () => {
  it('variant a gets the campaign subject, b gets ab_subject_b', () => {
    const c = abCampaign()
    expect(subjectForVariant(c, 'a')).toBe('Subject A')
    expect(subjectForVariant(c, 'b')).toBe('Subject B')
  })

  it('remainder (null variant) gets the winning subject', () => {
    expect(subjectForVariant(abCampaign({ ab_winner: 'b' }), null)).toBe('Subject B')
    expect(subjectForVariant(abCampaign({ ab_winner: 'a' }), null)).toBe('Subject A')
  })

  it('remainder before a decision falls back to subject A', () => {
    expect(subjectForVariant(abCampaign(), null)).toBe('Subject A')
  })

  it('default path (no A/B) always returns the campaign subject', () => {
    const c = { subject: 'Only subject' }
    expect(subjectForVariant(c, null)).toBe('Only subject')
    expect(subjectForVariant(c, undefined)).toBe('Only subject')
  })

  it('a blank ab_subject_b can never blank an email subject', () => {
    const c = abCampaign({ ab_subject_b: '' })
    expect(subjectForVariant(c, 'b')).toBe('Subject A')
  })
})
