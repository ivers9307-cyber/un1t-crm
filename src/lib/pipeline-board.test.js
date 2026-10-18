import { describe, it, expect } from 'vitest'
import {
  toBoardDeal, boardDealMapper, badgeEnabledForModule, boardCardOptionsForModule, pipelineContactFields, PIPELINE_PAGE_SIZE,
  ageDays, formatAge, dealAge, PIPELINE_BACKFILL_CUTOFF,
} from './pipeline-board.js'

describe('toBoardDeal', () => {
  it('strips recent_bookings from the outgoing payload', () => {
    const out = toBoardDeal({
      id: 'd1', stage_id: 's1', title: 't',
      contacts: { id: 'c1', name: 'Ann', pipeline_stage_slug: 'member', recent_bookings: [{ start: 'x' }] },
    })
    expect(out.contacts.recent_bookings).toBeUndefined()
    expect(out.contacts.id).toBe('c1')
  })

  it('null next_class_at for non-badge (off-funnel) stages', () => {
    const out = toBoardDeal({ id: 'd', contacts: { id: 'c', pipeline_stage_slug: 'dormant', recent_bookings: [] } })
    expect(out.contacts.next_class_at).toBeNull()
  })

  it('derives next_class_at only for the four funnel badge stages', () => {
    for (const slug of ['new_lead', 'first_class', 'second_class', 'trial_done']) {
      const out = toBoardDeal({ id: 'd', contacts: { id: 'c', pipeline_stage_slug: slug, recent_bookings: null } })
      // Present as a key (value comes from nextBookedClass; null with no bookings).
      expect('next_class_at' in out.contacts).toBe(true)
    }
    const off = toBoardDeal({ id: 'd', contacts: { id: 'c', pipeline_stage_slug: 'converted', recent_bookings: null } })
    expect(off.contacts.next_class_at).toBeNull()
  })

  it('tolerates a missing contacts object', () => {
    const out = toBoardDeal({ id: 'd', stage_id: 's' })
    expect(out.contacts.next_class_at).toBeNull()
  })
})

// Fixed "now" for age tests: 2026-07-29T12:00:00Z.
const NOW = Date.UTC(2026, 6, 29, 12)

describe('ageDays / formatAge', () => {
  it('whole days, clamped at zero, null on bad input', () => {
    expect(ageDays('2026-07-27T12:00:00Z', NOW)).toBe(2)
    expect(ageDays('2026-07-29T11:00:00Z', NOW)).toBe(0)
    expect(ageDays('2026-08-01T00:00:00Z', NOW)).toBe(0) // future → clamp
    expect(ageDays(null, NOW)).toBeNull()
    expect(ageDays('not-a-date', NOW)).toBeNull()
  })

  it('formats today/days/weeks/months', () => {
    expect(formatAge(0)).toBe('today')
    expect(formatAge(3)).toBe('3d')
    expect(formatAge(17)).toBe('2w')
    expect(formatAge(59)).toBe('8w')
    expect(formatAge(70)).toBe('2mo')
    expect(formatAge(null)).toBeNull()
  })
})

describe('dealAge', () => {
  it('uses the stage stamp for tone and keeps total as context', () => {
    const age = dealAge({ created_at: '2026-06-24T10:00:00Z', stage_entered_at: '2026-07-04T10:00:00Z' }, NOW)
    expect(age.stage).toBe('3w')   // 25 days
    expect(age.total).toBe('5w')   // 35 days
    expect(age.tone).toBe('stale') // 25d ≥ 21d
    expect(age.backfilled).toBe(false)
  })

  it('falls back to pipeline age when no stage stamp exists', () => {
    const age = dealAge({ created_at: '2026-07-19T10:00:00Z', stage_entered_at: null }, NOW)
    expect(age.stage).toBeNull()
    expect(age.total).toBe('1w')
    expect(age.tone).toBe('warm') // 10d in [7, 21)
  })

  it('backfilled deals label the total and never colour off import age', () => {
    const age = dealAge({ created_at: '2026-05-12T10:00:00Z', stage_entered_at: null }, NOW)
    expect(age.backfilled).toBe(true)
    expect(age.total).toBe("since May '26")
    expect(age.tone).toBe('quiet') // no false red from the import date
  })

  it('backfilled deal WITH a stage stamp colours on stage age', () => {
    const age = dealAge({ created_at: '2026-05-12T10:00:00Z', stage_entered_at: '2026-07-28T10:00:00Z' }, NOW)
    expect(age.stage).toBe('1d')
    expect(age.tone).toBe('quiet')
    expect(age.total).toBe("since May '26")
  })

  it('fresh deals stay quiet', () => {
    const age = dealAge({ created_at: '2026-07-28T10:00:00Z', stage_entered_at: '2026-07-29T09:00:00Z' }, NOW)
    expect(age.stage).toBe('today')
    expect(age.tone).toBe('quiet')
  })

  it('cutoff constant is a date string the comparison understands', () => {
    expect(PIPELINE_BACKFILL_CUTOFF).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('toBoardDeal age passthrough', () => {
  it('attaches a server-derived age object', () => {
    const out = toBoardDeal({ id: 'd', created_at: '2026-06-20T10:00:00Z', stage_entered_at: null, contacts: { id: 'c', pipeline_stage_slug: 'new_lead' } })
    expect(out.age).toBeTruthy()
    expect(typeof out.age.tone).toBe('string')
    expect(out.age.stage).toBeNull()
  })
})

describe('pipelineContactFields', () => {
  it('includes recent_bookings only on the funnel (non-dormant) view', () => {
    expect(pipelineContactFields('active')).toContain('recent_bookings')
    expect(pipelineContactFields('dormant')).not.toContain('recent_bookings')
  })
  it('page size is a sane positive number', () => {
    expect(PIPELINE_PAGE_SIZE).toBeGreaterThan(0)
  })
})

describe('boardDealMapper', () => {
  // unix SECONDS (Glofox convention), a day ahead of the real clock.
  const FUTURE_SECONDS = Math.floor(Date.now() / 1000) + 86400
  const deal = {
    id: 'd1', stage_id: 's1', title: 't', created_at: '2026-09-01T00:00:00Z',
    contacts: {
      id: 'c1', name: 'Ann', pipeline_stage_slug: 'new_lead',
      recent_bookings: [{ status: 'BOOKED', time_start: FUTURE_SECONDS }],
    },
  }

  it('positive control: the default mapper and toBoardDeal derive an ISO next_class_at for this deal', () => {
    const expected = new Date(FUTURE_SECONDS * 1000).toISOString()
    expect(boardDealMapper()(deal).contacts.next_class_at).toBe(expected)
    expect(toBoardDeal(deal).contacts.next_class_at).toBe(expected)
  })

  it('boardDealMapper({ badge:false }) sets next_class_at null and still strips recent_bookings', () => {
    const out = boardDealMapper({ badge: false })(deal)
    expect(out.contacts.next_class_at).toBeNull()
    expect(out.contacts.recent_bookings).toBeUndefined()
    expect(out.contacts.id).toBe('c1')
    expect(out.age).toBeTruthy()
  })

  it('toBoardDeal unchanged', () => {
    const viaDefault = boardDealMapper()(deal)
    const direct = toBoardDeal(deal)
    expect(direct.contacts).toEqual(viaDefault.contacts)
    expect(direct.contacts.recent_bookings).toBeUndefined()
    expect(direct.contacts.next_class_at).not.toBeNull()
    // 1-arg: safe in .map (the index must not be read as an option bag)
    const mapped = [deal, deal].map(toBoardDeal)
    expect(mapped).toHaveLength(2)
  })

  it('is safe in .map with a deal that has no contacts', () => {
    const out = [{ id: 'd' }].map(boardDealMapper({ badge: false }))[0]
    expect(out.contacts.next_class_at).toBeNull()
  })
})

describe('badgeEnabledForModule', () => {
  it('acquisition true, acquisition_un1t false, unknown true', () => {
    expect(badgeEnabledForModule('acquisition')).toBe(true)
    expect(badgeEnabledForModule('acquisition_un1t')).toBe(false)
    expect(badgeEnabledForModule('nope')).toBe(true)
    expect(badgeEnabledForModule(null)).toBe(true)
    expect(badgeEnabledForModule(undefined)).toBe(true)
  })
})

// HATCHPIPE.3 — a un1t.online board's card must not show the Glofox credit
// count: on a dual-studio contact `contacts.trial_credits_remaining` is
// Stillorgan's. Decided by the board module's inputSource, never a location id.
describe('Glofox credit count on board cards', () => {
  const deal = {
    id: 'd1', stage_id: 's1', title: 't', created_at: '2026-09-01T00:00:00Z',
    contacts: { id: 'c1', name: 'Ann', pipeline_stage_slug: 'new_lead', trial_credits_remaining: 2, recent_bookings: [] },
  }

  it('boardCardOptionsForModule: a un1t.online board gets no badge and no Glofox credits', () => {
    expect(boardCardOptionsForModule('acquisition_un1t')).toEqual({ badge: false, glofoxCredits: false })
  })

  it('boardCardOptionsForModule: Glofox, unknown and absent modules keep both (today\'s behaviour)', () => {
    for (const m of ['acquisition', 'returning', 'nope', null, undefined]) {
      expect(boardCardOptionsForModule(m)).toEqual({ badge: true, glofoxCredits: true })
    }
  })

  it('boardDealMapper({ glofoxCredits:false }) strips trial_credits_remaining', () => {
    const out = boardDealMapper({ badge: false, glofoxCredits: false })(deal)
    expect(out.contacts).not.toHaveProperty('trial_credits_remaining')
    expect(out.contacts.id).toBe('c1')
  })

  it('a Glofox board (Stillorgan) keeps the credit count, byte-identical to the default mapper', () => {
    const viaOptions = boardDealMapper(boardCardOptionsForModule('acquisition'))(deal)
    const viaDefault = toBoardDeal(deal)
    expect(viaOptions.contacts.trial_credits_remaining).toBe(2)
    expect(JSON.stringify(viaOptions.contacts)).toBe(JSON.stringify(viaDefault.contacts))
  })

  it('the board mapper never mutates the row it was given', () => {
    boardDealMapper({ glofoxCredits: false })(deal)
    expect(deal.contacts.trial_credits_remaining).toBe(2)
  })
})
