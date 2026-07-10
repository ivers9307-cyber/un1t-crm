import { describe, it, expect } from 'vitest'
import {
  SCHEDULED_BLAST_MAX_PER_TICK,
  promotionPlan,
  sliceBlastChunk,
  scheduledStartFailureNotification,
} from './whatsapp-schedule.js'

describe('promotionPlan — how the cron promotes a due scheduled broadcast', () => {
  it('promotes a scheduled drip straight to sending (the drip engine takes over)', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'drip' }))
      .toEqual({ mode: 'drip', flipTo: 'sending' })
  })

  it('promotes a scheduled blast to draft (sendBroadcast owns the draft→sending CAS + gates)', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'blast' }))
      .toEqual({ mode: 'blast', flipTo: 'draft' })
  })

  it('treats a missing delivery_mode as blast (pre-drip rows default to blast)', () => {
    expect(promotionPlan({ status: 'scheduled' }))
      .toEqual({ mode: 'blast', flipTo: 'draft' })
  })

  it('returns null for anything not in scheduled state (cancelled, draft, sending, sent)', () => {
    for (const status of ['draft', 'sending', 'sent', 'cancelled', undefined]) {
      expect(promotionPlan({ status, delivery_mode: 'blast' })).toBeNull()
    }
    expect(promotionPlan(null)).toBeNull()
  })
})

describe('sliceBlastChunk — per-tick cap for cron-driven blasts', () => {
  const pending = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]

  it('no cap → whole pending set, nothing deferred (operator-fired path unchanged)', () => {
    expect(sliceBlastChunk(pending, undefined)).toEqual({ batch: pending, deferred: 0 })
    expect(sliceBlastChunk(pending, null)).toEqual({ batch: pending, deferred: 0 })
    expect(sliceBlastChunk(pending, 0)).toEqual({ batch: pending, deferred: 0 })
  })

  it('cap below pending → first N, remainder deferred for the next tick', () => {
    expect(sliceBlastChunk(pending, 2)).toEqual({ batch: [{ id: 'a' }, { id: 'b' }], deferred: 1 })
  })

  it('cap at or above pending → everything in one batch', () => {
    expect(sliceBlastChunk(pending, 3)).toEqual({ batch: pending, deferred: 0 })
    expect(sliceBlastChunk(pending, 99)).toEqual({ batch: pending, deferred: 0 })
  })

  it('empty pending → empty batch', () => {
    expect(sliceBlastChunk([], 5)).toEqual({ batch: [], deferred: 0 })
  })

  it('default chunk is positive and small enough to finish inside the cron maxDuration', () => {
    expect(SCHEDULED_BLAST_MAX_PER_TICK).toBeGreaterThan(0)
    expect(SCHEDULED_BLAST_MAX_PER_TICK).toBeLessThanOrEqual(1000)
  })
})

describe('scheduledStartFailureNotification — manager push when a scheduled send is refused', () => {
  it('names the broadcast and carries the refusal reason', () => {
    const n = scheduledStartFailureNotification(
      { name: 'July promo' },
      'This location\'s WhatsApp number quality is RED — sending paused to protect the number.'
    )
    expect(n.title).toMatch(/scheduled/i)
    expect(n.body).toContain('"July promo"')
    expect(n.body).toMatch(/RED/)
    expect(n.body).toMatch(/draft/i) // tells the operator where to find it
  })

  it('degrades gracefully with no name / no error', () => {
    const n = scheduledStartFailureNotification({}, null)
    expect(n.title).toBeTruthy()
    expect(n.body).toMatch(/broadcast/i)
  })
})
