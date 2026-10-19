// src/lib/agent/trial-done.test.js
// TRIALDONE.4/.5 — the pure decisions behind the trial-done outreach: when the
// opener is due (openerDecision), when the one follow-up is due and which kind
// (followupDecision), and who may get either (eligibilityVerdict).
import { describe, it, expect } from 'vitest'
import {
  openerDecision, followupDecision, eligibilityVerdict, TRIAL_DONE_CLAIM_LEASE_MS, TRIAL_DONE_NUDGE_INSTRUCTION,
} from './trial-done'
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

  // TRIALDONE.5 hardening: an input the runner failed to supply is never
  // "eligible". It fails CLOSED with inputs_missing, which the runner treats
  // as a defer (skip this tick), never a close.
  it('a missing reasons list fails closed: inputs_missing', () => {
    expect(v({ eligibilityReasons: undefined })).toEqual({ ok: false, reason: 'inputs_missing' })
    expect(v({ eligibilityReasons: null })).toEqual({ ok: false, reason: 'inputs_missing' })
    expect(v({ eligibilityReasons: 'paid_pack' })).toEqual({ ok: false, reason: 'inputs_missing' })
  })

  it('a missing activeElsewhere or isStaff fails closed: inputs_missing', () => {
    expect(v({ activeElsewhere: undefined })).toEqual({ ok: false, reason: 'inputs_missing' })
    expect(v({ activeElsewhere: null })).toEqual({ ok: false, reason: 'inputs_missing' })
    expect(v({ isStaff: undefined })).toEqual({ ok: false, reason: 'inputs_missing' })
    expect(v({ isStaff: 'false' })).toEqual({ ok: false, reason: 'inputs_missing' })
    expect(eligibilityVerdict()).toEqual({ ok: false, reason: 'inputs_missing' })
  })
})

describe('followupDecision', () => {
  const O = AT + 2 * H // the opener went
  const sent = { id: 'r1', opener_sent_at: new Date(O).toISOString(), followup_sent_at: null, closed_at: null }
  const fu = (nowMs, over = {}) => followupDecision({ outreach: sent, lastInboundAtMs: null, lastOutboundAtMs: null, nowMs, settings, ...over })

  it('no_opener before the opener went', () => {
    expect(fu(O + 22 * H, { outreach: { ...sent, opener_sent_at: null } })).toEqual({ action: null, reason: 'no_opener' })
    expect(fu(O + 22 * H, { outreach: null })).toEqual({ action: null, reason: 'no_opener' })
    expect(fu(O + 22 * H, { outreach: { ...sent, opener_sent_at: 'nope' } })).toEqual({ action: null, reason: 'no_opener' })
  })

  it('closed once the row is closed', () => {
    expect(fu(O + 22 * H, { outreach: { ...sent, closed_at: new Date(O).toISOString() } })).toEqual({ action: null, reason: 'closed' })
  })

  it('already_followed_up once the follow-up went', () => {
    expect(fu(O + 22 * H, { outreach: { ...sent, followup_sent_at: new Date(O + 22 * H).toISOString() } }))
      .toEqual({ action: null, reason: 'already_followed_up' })
  })

  describe('they never replied: the template, opener + 22h to + 30h', () => {
    it('too_soon at opener + 21h59m', () => {
      expect(fu(O + 21 * H + 59 * M)).toEqual({ action: null, reason: 'too_soon' })
    })
    it('template at opener + 22h', () => {
      expect(fu(O + 22 * H)).toEqual({ action: 'template' })
    })
    it('template at opener + 30h exactly (the last moment)', () => {
      expect(fu(O + 30 * H)).toEqual({ action: 'template' })
    })
    it('window_passed at opener + 30h01m', () => {
      expect(fu(O + 30 * H + M)).toEqual({ action: null, reason: 'window_passed' })
    })
    it('a message from before the opener is not a reply', () => {
      expect(fu(O + 22 * H, { lastInboundAtMs: O - H, lastOutboundAtMs: O })).toEqual({ action: 'template' })
    })
    it('reads followup_after_hours and followup_max_hours from the settings', () => {
      const s = { ...settings, followup_after_hours: 23, followup_max_hours: 25 }
      expect(fu(O + 22 * H, { settings: s })).toEqual({ action: null, reason: 'too_soon' })
      expect(fu(O + 23 * H, { settings: s })).toEqual({ action: 'template' })
      expect(fu(O + 25 * H + M, { settings: s })).toEqual({ action: null, reason: 'window_passed' })
    })
  })

  describe('they replied: one nudge, their last message + 3h to + 20h', () => {
    const IN = O + 1 * H
    const replied = { lastInboundAtMs: IN, lastOutboundAtMs: IN + 5 * M } // Mia answered last

    it('too_soon at their last message + 2h59m', () => {
      expect(fu(IN + 2 * H + 59 * M, replied)).toEqual({ action: null, reason: 'too_soon' })
    })
    it('nudge at their last message + 3h', () => {
      expect(fu(IN + 3 * H, replied)).toEqual({ action: 'nudge' })
    })
    it('nudge at their last message + 20h exactly (the last moment)', () => {
      expect(fu(IN + 20 * H, replied)).toEqual({ action: 'nudge' })
    })
    it('window_passed at their last message + 20h01m', () => {
      expect(fu(IN + 20 * H + M, replied)).toEqual({ action: null, reason: 'window_passed' })
    })
    it('awaiting_mia while their message is newer than her last one', () => {
      expect(fu(IN + 5 * H, { lastInboundAtMs: IN, lastOutboundAtMs: IN - M })).toEqual({ action: null, reason: 'awaiting_mia' })
      expect(fu(IN + 5 * H, { lastInboundAtMs: IN, lastOutboundAtMs: null })).toEqual({ action: null, reason: 'awaiting_mia' })
    })
    it('reads nudge_after_hours and nudge_max_hours from the settings', () => {
      const s = { ...settings, nudge_after_hours: 4, nudge_max_hours: 6 }
      expect(fu(IN + 3 * H, { ...replied, settings: s })).toEqual({ action: null, reason: 'too_soon' })
      expect(fu(IN + 4 * H, { ...replied, settings: s })).toEqual({ action: 'nudge' })
      expect(fu(IN + 6 * H + M, { ...replied, settings: s })).toEqual({ action: null, reason: 'window_passed' })
    })
  })

  it('defaults apply when settings are missing', () => {
    expect(followupDecision({ outreach: sent, nowMs: O + 22 * H })).toEqual({ action: 'template' })
  })

  // TRIALDONE.7 — the nudge is a free-form reply: it must land inside
  // WhatsApp's 24h window, so nudge_max_hours is clamped to 23.
  it('nudge_max_hours above 23 behaves as 23 (inside the 24h window)', () => {
    const IN = O + 1 * H
    const replied = { lastInboundAtMs: IN, lastOutboundAtMs: IN + 5 * M }
    const s = { ...settings, nudge_max_hours: 30 }
    expect(fu(IN + 23 * H, { ...replied, settings: s })).toEqual({ action: 'nudge' })
    expect(fu(IN + 23 * H + M, { ...replied, settings: s })).toEqual({ action: null, reason: 'window_passed' })
    expect(fu(IN + 29 * H, { ...replied, settings: s })).toEqual({ action: null, reason: 'window_passed' })
    // at or below 23 the setting is read as is
    expect(fu(IN + 22 * H + M, { ...replied, settings: { ...settings, nudge_max_hours: 22 } })).toEqual({ action: null, reason: 'window_passed' })
  })
})

describe('TRIAL_DONE_NUDGE_INSTRUCTION', () => {
  it('is the brief\'s instruction, verbatim, with no em-dash', () => {
    expect(TRIAL_DONE_NUDGE_INSTRUCTION).toBe('[STUDIO SYSTEM - not the customer] They finished their trial and talked with you about continuing, then went quiet. Write one short, friendly check-in that picks up where you left off. No prices unless you already gave them. No pressure. If they declined, said they will decide later, or there is nothing open to follow up on, reply with exactly [[SKIP]] and nothing else.')
    expect(TRIAL_DONE_NUDGE_INSTRUCTION).not.toMatch(/[\u2013\u2014]/)
  })

  // TRIALDONE.7 — Mia may skip: a decline or a "later" ends the sequence.
  it('lets Mia skip with exactly [[SKIP]] when they declined or there is nothing open', () => {
    expect(TRIAL_DONE_NUDGE_INSTRUCTION).toContain('If they declined, said they will decide later, or there is nothing open to follow up on, reply with exactly [[SKIP]] and nothing else.')
  })
})
