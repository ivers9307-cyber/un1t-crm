import { describe, it, expect } from 'vitest'
import { formatMembership } from './account-tools.js'

// GLOFOX-CATALOG → agent: get_my_membership now surfaces the plan's
// catalog description (pricing + commitment terms) as `plan_details`
// when the executor has resolved it onto the row as membership_description.
describe('formatMembership plan_details', () => {
  it('surfaces plan_details when membership_description is present', () => {
    const out = formatMembership({
      glofox_membership_state: 'active',
      glofox_account_active: true,
      glofox_membership_plan: 'Unlimited Monthly',
      membership_description: '\u20ac120/mo, rolling monthly, cancel anytime with 30 days notice',
    })
    expect(out.found).toBe(true)
    expect(out.plan).toBe('Unlimited Monthly')
    expect(out.plan_details).toBe('\u20ac120/mo, rolling monthly, cancel anytime with 30 days notice')
  })

  it('omits plan_details when no description resolved', () => {
    const out = formatMembership({
      glofox_membership_state: 'active',
      glofox_account_active: true,
      glofox_membership_plan: 'Some Archived Promo',
    })
    expect(out.found).toBe(true)
    expect(out.plan).toBe('Some Archived Promo')
    expect(out.plan_details).toBeUndefined()
  })

  it('still works with no plan at all', () => {
    const out = formatMembership({
      glofox_membership_state: 'paused',
      glofox_account_active: false,
    })
    expect(out.found).toBe(true)
    expect(out.status).toBe('paused')
    expect(out.plan).toBeUndefined()
    expect(out.plan_details).toBeUndefined()
  })
})
