import { describe, it, expect } from 'vitest'
import { getNextSteps, buildDeclineDraft, DECLINE_REASONS } from './approvals-next-steps.js'

const ctx = {
  firstName: 'Aoife',
  details: { class_name: 'Core Fusion', class_time: 'Wed 9:30am' },
}

describe('getNextSteps', () => {
  it('declined booking → offer slots (book) + explanation (composer with draft)', () => {
    const steps = getNextSteps('class_booking', 'declined', { ...ctx, reason: 'class_full' })
    expect(steps.map(s => s.type)).toEqual(['book', 'composer'])
    expect(steps[1].draft).toContain('Aoife')
    expect(steps[1].draft).toContain('Core Fusion')
  })

  it('approved cancellation → sequence + book + composer', () => {
    const steps = getNextSteps('cancellation', 'approved', ctx)
    expect(steps.map(s => s.type)).toEqual(['sequence', 'book', 'composer'])
  })

  it('approved pause → single composer step embedding the dates', () => {
    const steps = getNextSteps('pause', 'approved', {
      firstName: 'Dan',
      details: { start_date: '2026-08-01', end_date: '2026-09-01' },
    })
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('composer')
    expect(steps[0].draft).toContain('2026-08-01 to 2026-09-01')
  })

  it('actioned (auto-executed) → no steps (Mia already confirmed)', () => {
    expect(getNextSteps('class_booking', 'actioned', ctx)).toEqual([])
  })

  it('failed booking → book manually + holding message', () => {
    const steps = getNextSteps('class_booking', 'failed', ctx)
    expect(steps.map(s => s.type)).toEqual(['book', 'composer'])
  })

  it('saved cancellation → thank-you composer step', () => {
    const steps = getNextSteps('cancellation', 'saved', ctx)
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('composer')
  })

  it('unknown combinations → empty array, never throws', () => {
    expect(getNextSteps('mystery_kind', 'approved', {})).toEqual([])
    expect(getNextSteps(null, null)).toEqual([])
  })
})

describe('buildDeclineDraft', () => {
  it('mentions the class and reads as Mia-voiced text for class_full', () => {
    const draft = buildDeclineDraft('class_booking', 'class_full', ctx)
    expect(draft).toContain('Aoife')
    expect(draft).toContain('Core Fusion')
    expect(draft.toLowerCase()).toContain('fully booked')
  })
  it('falls back gracefully with no ctx', () => {
    expect(buildDeclineDraft('class_booking', 'other', {})).toContain('there')
  })
})

describe('DECLINE_REASONS', () => {
  it('exposes [key, label] pairs including other', () => {
    expect(DECLINE_REASONS.map(([k]) => k)).toContain('other')
  })
})
