import { describe, it, expect } from 'vitest'
import {
  SCHEDULED_BLAST_MAX_PER_TICK,
  LATE_SCHEDULED_BLAST_HOURS,
  LATE_SCHEDULED_BLAST_REASON,
  promotionPlan,
  sliceBlastChunk,
  scheduledStartFailureNotification,
  resumeIsStale,
  LATE_RESUME_REASON,
} from './whatsapp-schedule.js'

describe('promotionPlan — how the cron promotes a due scheduled broadcast', () => {
  // C138 (b) — a drip goes to draft first, like a blast: sendBroadcast then runs
  // a drip's start checks (template, URL value, own number, quality, wallet) and
  // owns the draft→sending CAS, so a refused start is a draft plus a manager push.
  it('promotes a scheduled drip to draft (sendBroadcast starts it after the start checks)', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'drip' }))
      .toEqual({ mode: 'drip', flipTo: 'draft' })
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

// C127 LATEBLAST.1 (Richard, 30 Sep) — a scheduled BLAST that fell due while
// its studio's WhatsApp was off must not go out the moment it is switched back
// on. More than N = 3 hours late, it returns to draft (scheduled_at cleared)
// and the managers are told; it is never sent stale. Drips pace themselves
// inside their window, so they are untouched.
describe('promotionPlan — a late scheduled blast is returned, never sent (C127)', () => {
  const now = new Date('2026-10-01T12:00:00.000Z')
  const ago = (ms) => new Date(now.getTime() - ms).toISOString()
  const H = 3600 * 1000

  it('N is 3 hours', () => expect(LATE_SCHEDULED_BLAST_HOURS).toBe(3))

  it('a blast more than 3 hours late is stale: back to draft, schedule cleared', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(3 * H + 1000) }, now))
      .toEqual({ mode: 'stale', flipTo: 'draft' })
    expect(promotionPlan({ status: 'scheduled', scheduled_at: ago(30 * 24 * H) }, now))
      .toEqual({ mode: 'stale', flipTo: 'draft' })
  })

  it('a blast up to 3 hours late still goes (a slow tick is not stale)', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(3 * H) }, now))
      .toEqual({ mode: 'blast', flipTo: 'draft' })
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(15 * 60 * 1000) }, now))
      .toEqual({ mode: 'blast', flipTo: 'draft' })
  })

  it('a late drip is never stale (it paces itself inside its window)', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'drip', scheduled_at: ago(48 * H) }, now))
      .toEqual({ mode: 'drip', flipTo: 'draft' })
  })

  it('no clock, or an unreadable time, keeps the old plan', () => {
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'blast', scheduled_at: ago(48 * H) }))
      .toEqual({ mode: 'blast', flipTo: 'draft' })
    expect(promotionPlan({ status: 'scheduled', delivery_mode: 'blast', scheduled_at: 'nonsense' }, now))
      .toEqual({ mode: 'blast', flipTo: 'draft' })
  })

  it('the managers\' notice says why, with no em-dash in the new words', () => {
    expect(LATE_SCHEDULED_BLAST_REASON).toMatch(/more than 3 hours late/)
    expect(LATE_SCHEDULED_BLAST_REASON).not.toMatch(/\u2014/)
    const n = scheduledStartFailureNotification({ name: 'Spring' }, LATE_SCHEDULED_BLAST_REASON)
    expect(n.body).toContain(LATE_SCHEDULED_BLAST_REASON)
    expect(n.body).toMatch(/returned to draft/)
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

// C139 LATERESUME.1 (Richard's C127 rule: never send stale) — a PART-SENT
// scheduled blast whose last send is more than 3 hours old when the cron's
// resume arm reaches it is paused and the managers told, never resumed.
describe('resumeIsStale — a part-sent blast is never resumed stale (C139)', () => {
  const now = new Date('2026-10-02T12:00:00.000Z')
  const ago = (ms) => new Date(now.getTime() - ms).toISOString()
  const H = 3600 * 1000

  it('uses the same 3 hours as a late start', () => {
    expect(resumeIsStale(ago(LATE_SCHEDULED_BLAST_HOURS * H + 1000), now)).toBe(true)
    expect(resumeIsStale(ago(LATE_SCHEDULED_BLAST_HOURS * H), now)).toBe(false)
  })

  it('a resume a tick or two later is not stale', () => {
    expect(resumeIsStale(ago(15 * 60 * 1000), now)).toBe(false)
    expect(resumeIsStale(ago(45 * 60 * 1000), now)).toBe(false)
  })

  it('no clock, or an unreadable time, is not stale (the promotionPlan posture)', () => {
    expect(resumeIsStale(ago(48 * H))).toBe(false)
    expect(resumeIsStale(null, now)).toBe(false)
    expect(resumeIsStale('nonsense', now)).toBe(false)
  })

  it('the managers\' push says it stopped part-way, what was kept, and why; no em-dash in the new words', () => {
    expect(LATE_RESUME_REASON).toMatch(/more than 3 hours ago/)
    expect(LATE_RESUME_REASON).not.toMatch(/\u2014/)
    const n = scheduledStartFailureNotification({ name: 'Spring' }, LATE_RESUME_REASON, { partSent: true })
    expect(n.title).toBe('Scheduled WhatsApp broadcast paused part-way')
    expect(n.body).toContain('"Spring"')
    expect(n.body).toContain(LATE_RESUME_REASON)
    expect(n.body).toMatch(/already sent/)
    expect(n.body).toMatch(/draft/)
    expect(n.title + n.body).not.toMatch(/\u2014/)
  })

  it('without partSent the start-failure wording is unchanged', () => {
    expect(scheduledStartFailureNotification({ name: 'Spring' }, 'x').title).toBe('Scheduled WhatsApp broadcast did not start')
  })
})
