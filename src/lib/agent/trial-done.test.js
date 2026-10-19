// src/lib/agent/trial-done.test.js
// TRIALDONE.4 — the pure decisions behind the trial-done opener: when it is
// due (openerDecision) and who may get it (eligibilityVerdict).
import { describe, it, expect } from 'vitest'
import { openerDecision, eligibilityVerdict, TRIAL_DONE_CLAIM_LEASE_MS } from './trial-done'
import { DEFAULTS } from './settings-contract'

const H = 3600_000
const M = 60_000
const AT = Date.UTC(2026, 9, 20, 10, 0, 0) // the 3rd class ended
const trigger = { kind: 'three_attended', at: new Date(AT).toISOString() }
const settings = { ...DEFAULTS.trial_done }
const open = { id: 'r1', opener_claimed_at: null, opener_sent_at: null, closed_at: null }
const decide = (nowMs, over = {}) => openerDecision({ trigger, outreach: open, nowMs, settings, ...over })

describe('openerDecision', () => {
  it('is the 30-minute lease', () => {
    expect(TRIAL_DONE_CLAIM_LEASE_MS).toBe(30 * M)
  })

  it('too_soon at trigger + 1h59m', () => {
    expect(decide(AT + 1 * H + 59 * M)).toEqual({ action: null, reason: 'too_soon' })
  })

  it('opener at trigger + 2h', () => {
    expect(decide(AT + 2 * H)).toEqual({ action: 'opener' })
  })

  it('opener at trigger + 24h exactly (the last moment)', () => {
    expect(decide(AT + 24 * H)).toEqual({ action: 'opener' })
  })

  it('stale at trigger + 24h01m', () => {
    expect(decide(AT + 24 * H + 1 * M)).toEqual({ action: null, reason: 'stale' })
  })

  it('a trigger in the future is too_soon (the reads module reads no clock)', () => {
    expect(decide(AT - 5 * H)).toEqual({ action: null, reason: 'too_soon' })
  })

  it('reads delay_hours and stale_after_hours from the settings', () => {
    const s = { ...settings, delay_hours: 4, stale_after_hours: 6 }
    expect(openerDecision({ trigger, outreach: open, nowMs: AT + 3 * H, settings: s })).toEqual({ action: null, reason: 'too_soon' })
    expect(openerDecision({ trigger, outreach: open, nowMs: AT + 4 * H, settings: s })).toEqual({ action: 'opener' })
    expect(openerDecision({ trigger, outreach: open, nowMs: AT + 6 * H + M, settings: s })).toEqual({ action: null, reason: 'stale' })
  })

  it('no trigger, or an unreadable one, is no_trigger', () => {
    expect(decide(AT + 2 * H, { trigger: null })).toEqual({ action: null, reason: 'no_trigger' })
    expect(decide(AT + 2 * H, { trigger: { kind: 'three_attended', at: 'nope' } })).toEqual({ action: null, reason: 'no_trigger' })
  })

  it('already_sent once the opener went', () => {
    const outreach = { ...open, opener_sent_at: new Date(AT + 2 * H).toISOString() }
    expect(decide(AT + 3 * H, { outreach })).toEqual({ action: null, reason: 'already_sent' })
  })

  it('closed once the row is closed', () => {
    const outreach = { ...open, closed_at: new Date(AT).toISOString(), closed_reason: 'staff' }
    expect(decide(AT + 3 * H, { outreach })).toEqual({ action: null, reason: 'closed' })
  })

  it('claimed within the lease, and not after it', () => {
    const now = AT + 3 * H
    const within = { ...open, opener_claimed_at: new Date(now - 29 * M).toISOString() }
    const after = { ...open, opener_claimed_at: new Date(now - 31 * M).toISOString() }
    expect(decide(now, { outreach: within })).toEqual({ action: null, reason: 'claimed' })
    expect(decide(now, { outreach: after })).toEqual({ action: 'opener' })
  })

  it('defaults apply when settings are missing', () => {
    expect(openerDecision({ trigger, outreach: open, nowMs: AT + 2 * H })).toEqual({ action: 'opener' })
  })
})

describe('eligibilityVerdict', () => {
  const ok = {
    stage: 'trial_done', eligibilityReasons: [], activeElsewhere: false, isStaff: false, waStatus: 'active', hasConsent: true,
  }
  const v = (over) => eligibilityVerdict({ ...ok, ...over })

  it('a trial finisher with consent is ok', () => {
    expect(v({})).toEqual({ ok: true })
  })

  it('trial_used alone is ok (they used the trial; that is the point)', () => {
    expect(v({ eligibilityReasons: ['trial_used'] })).toEqual({ ok: true })
  })

  it('not_trial_done when the current classification moved on', () => {
    expect(v({ stage: 'second_class' })).toEqual({ ok: false, reason: 'not_trial_done' })
    expect(v({ stage: null })).toEqual({ ok: false, reason: 'not_trial_done' })
  })

  it('purchased for membership_history or paid_pack', () => {
    expect(v({ eligibilityReasons: ['trial_used', 'membership_history'] })).toEqual({ ok: false, reason: 'purchased' })
    expect(v({ eligibilityReasons: ['paid_pack'] })).toEqual({ ok: false, reason: 'purchased' })
  })

  it('a purchase is named even when the classification also moved on', () => {
    expect(v({ stage: 'converted', eligibilityReasons: ['membership_history'] })).toEqual({ ok: false, reason: 'purchased' })
  })

  it('active_elsewhere for an active member at another studio', () => {
    expect(v({ activeElsewhere: true })).toEqual({ ok: false, reason: 'active_elsewhere' })
  })

  it('staff', () => {
    expect(v({ isStaff: true })).toEqual({ ok: false, reason: 'staff' })
  })

  it.each(['opted_out', 'blocked', 'undeliverable'])('opted_out for wa_status %s', (waStatus) => {
    expect(v({ waStatus })).toEqual({ ok: false, reason: 'opted_out' })
  })

  it('no_consent without the studio consent row', () => {
    expect(v({ hasConsent: false })).toEqual({ ok: false, reason: 'no_consent' })
  })

  it('a missing reasons list is not a purchase', () => {
    expect(v({ eligibilityReasons: undefined })).toEqual({ ok: true })
  })
})
