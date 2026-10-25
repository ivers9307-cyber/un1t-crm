// C145 TRIALDEFAULT.1 (Richard, 2 Oct) — a new contact now starts with NO
// credit count (contacts.trial_credits_remaining = NULL) until Glofox says
// otherwise. Every reader must treat NULL as "no count": never print 0 or 3,
// never count it as credits, and Mia never quotes a number for it.
// These pin the pure readers; the components are pinned in
// src/components/trial-credits-null.test.jsx.

import { describe, it, expect } from 'vitest'
import { deriveNeedsAttention } from './contact-view.js'
import { accountSummaryLine } from './approvals/agent-request-why.js'
import { pickBestMembershipContact, formatMembership } from './agent/account-tools.js'
import { classifyContact } from '@shared/pipeline-classifier'

const NEW_LEAD = {
  id: 'c1', pipeline_stage_slug: 'new_lead', glofox_member_id: null,
  glofox_membership_status: null, trial_credits_remaining: null,
}

describe('C145 — NULL trial credits read as "no count"', () => {
  it('contact drawer attention: a NULL count still flags "No next class booked", with no number', () => {
    const items = deriveNeedsAttention({ contact: NEW_LEAD })
    const item = items.find((i) => i.key === 'no_next_class')
    expect(item).toEqual(expect.objectContaining({ label: 'No next class booked', detail: '' }))
    expect(JSON.stringify(items)).not.toMatch(/credit/)
  })

  it('contact drawer attention: a known 0 (trial spent) does not flag', () => {
    const items = deriveNeedsAttention({ contact: { ...NEW_LEAD, trial_credits_remaining: 0 } })
    expect(items.find((i) => i.key === 'no_next_class')).toBeUndefined()
  })

  it('approval card summary says "credits unknown", never 0 or 3', () => {
    const line = accountSummaryLine({ ...NEW_LEAD, glofox_membership_plan: 'Trial', glofox_membership_status: 'trial' })
    expect(line).toContain('credits unknown')
    expect(line).not.toMatch(/\b[03] credit/)
  })

  it('Mia: a NULL count is never "a trial with credits" in the membership pick', () => {
    const older = { id: 'a', glofox_membership_status: 'trial', trial_credits_remaining: null, updated_at: '2026-10-01T00:00:00Z' }
    const newer = { id: 'b', glofox_membership_status: 'lead', trial_credits_remaining: null, updated_at: '2026-10-02T00:00:00Z' }
    // Falls through to most-recent, not to the NULL "trial" row.
    expect(pickBestMembershipContact([older, newer]).id).toBe('b')
  })

  it('Mia: get_my_membership carries no credit number at all', () => {
    const out = formatMembership({ ...NEW_LEAD, glofox_membership_state: 'active', trial_credits_remaining: null })
    expect(JSON.stringify(out)).not.toMatch(/credit/i)
  })

  it('pipeline classifier: a NULL count is not a pack customer', () => {
    expect(classifyContact({ ...NEW_LEAD, created_at: new Date().toISOString() })).not.toBe('pack_member')
  })
})
