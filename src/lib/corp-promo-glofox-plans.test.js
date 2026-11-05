import { describe, it, expect } from 'vitest'
import { glofoxPlanForPromo } from './corp-promo-glofox-plans'

describe('glofoxPlanForPromo', () => {
  it('the newstart promo buys the New Start Free Trial plan Richard created on 5 Nov 2026', () => {
    expect(glofoxPlanForPromo('stillorgan-newstart')).toEqual({ membershipId: '6aec95d590a936f18c065d9f', planCode: '1793889679121', planName: 'New Start Free Trial' })
  })
  it('an unknown promo has no plan', () => {
    expect(glofoxPlanForPromo('nope')).toBeNull()
    expect(glofoxPlanForPromo('toString')).toBeNull()
    expect(glofoxPlanForPromo(undefined)).toBeNull()
  })
})
