import { describe, it, expect } from 'vitest'
import { ACTIVE_SET_LIMIT, ACTIVE_SET_OR, mergeActiveSet } from './inbox-active-set'
import * as web from '../src/lib/inbox-active-set'

describe('active set', () => {
  it('names the four ways a thread needs someone, and reads at most 300', () => {
    expect(ACTIVE_SET_LIMIT).toBe(300)
    expect(ACTIVE_SET_OR).toBe('last_message_direction.eq.inbound,handoff_requested_at.not.is.null,staff_waiting_since.not.is.null,snoozed_until.not.is.null')
  })

  it('the web path is the same module', () => {
    expect(web.mergeActiveSet).toBe(mergeActiveSet)
    expect(web.ACTIVE_SET_OR).toBe(ACTIVE_SET_OR)
  })

  it('adds the active rows the latest read lacks, newest message first', () => {
    const latest = [{ id: 'a', last_message_at: '2026-11-25T10:00:00Z' }, { id: 'b', last_message_at: '2026-11-25T08:00:00Z' }]
    const active = [{ id: 'b', last_message_at: '2026-11-25T08:00:00Z' }, { id: 'old', last_message_at: '2026-10-01T08:00:00Z' }, { id: 'mid', last_message_at: '2026-11-25T09:00:00Z' }]
    expect(mergeActiveSet(latest, active).map(c => c.id)).toEqual(['a', 'mid', 'b', 'old'])
  })

  it('returns the latest list untouched when the active read adds nothing or is missing', () => {
    const latest = [{ id: 'a' }]
    expect(mergeActiveSet(latest, [{ id: 'a' }])).toBe(latest)
    expect(mergeActiveSet(latest, null)).toBe(latest)
    expect(mergeActiveSet(null, null)).toEqual([])
  })
})
