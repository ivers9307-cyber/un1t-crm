import { describe, it, expect } from 'vitest'
import {
  inboundPatch, staffReplyPatch, agentReplyPatch, handoffRequestPatch,
  completePatch, handBackPatch, snoozePatch, unsnoozePatch,
} from './inbox-state.js'

const NOW = '2026-11-25T10:00:00.000Z'
const SNOOZE_NULLS = { snoozed_until: null, snoozed_by: null, snooze_note: null }

describe('inbox-state patch builders', () => {
  it('inboundPatch sets customer_waiting_since when unset', () => {
    expect(inboundPatch({}, NOW)).toEqual({
      customer_waiting_since: NOW, staff_waiting_since: null,
      staff_nudged_at: null, staff_nudge_outcome: null, ...SNOOZE_NULLS,
    })
  })
  it('inboundPatch keeps an existing customer_waiting_since', () => {
    const old = '2026-11-24T08:00:00.000Z'
    expect(inboundPatch({ customer_waiting_since: old }, NOW).customer_waiting_since).toBe(old)
    expect(inboundPatch(null, NOW).customer_waiting_since).toBe(NOW)
  })
  it('staffReplyPatch starts ownership and the wait on the customer', () => {
    expect(staffReplyPatch({}, NOW)).toEqual({
      staff_owned_since: NOW, staff_waiting_since: NOW, customer_waiting_since: null,
      staff_nudged_at: null, staff_nudge_outcome: null, handoff_requested_at: null, ...SNOOZE_NULLS,
    })
  })
  it('staffReplyPatch keeps an existing staff_owned_since', () => {
    const old = '2026-11-20T08:00:00.000Z'
    const p = staffReplyPatch({ staff_owned_since: old }, NOW)
    expect(p.staff_owned_since).toBe(old)
    expect(p.staff_waiting_since).toBe(NOW)
  })
  it('agentReplyPatch only clears customer_waiting_since', () => {
    expect(agentReplyPatch()).toEqual({ customer_waiting_since: null })
  })
  it('handoffRequestPatch stamps handoff_requested_at', () => {
    expect(handoffRequestPatch(NOW)).toEqual({ handoff_requested_at: NOW })
  })
  it('completePatch nulls all nine columns', () => {
    expect(completePatch()).toEqual({
      customer_waiting_since: null, staff_owned_since: null, staff_waiting_since: null,
      staff_nudged_at: null, staff_nudge_outcome: null, handoff_requested_at: null, ...SNOOZE_NULLS,
    })
    expect(Object.keys(completePatch())).toHaveLength(9)
  })
  it('handBackPatch completes and returns the thread to Mia', () => {
    expect(handBackPatch()).toEqual({
      ...completePatch(), agent_active: true, agent_handed_off_at: null, handoff_escalated_at: null,
    })
  })
  it('snoozePatch and unsnoozePatch', () => {
    expect(snoozePatch({ untilIso: NOW, userId: 'u1', note: 'call back' })).toEqual({
      snoozed_until: NOW, snoozed_by: 'u1', snooze_note: 'call back',
    })
    expect(snoozePatch({ untilIso: NOW, userId: 'u1' }).snooze_note).toBeNull()
    expect(unsnoozePatch()).toEqual(SNOOZE_NULLS)
  })
})
