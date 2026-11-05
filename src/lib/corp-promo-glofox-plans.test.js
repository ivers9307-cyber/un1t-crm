import { describe, it, expect } from 'vitest'
import { glofoxPlanForPromo } from './corp-promo-glofox-plans'

describe('glofoxPlanForPromo', () => {
  it('a promo with blank plan ids has no plan', () => {
    expect(glofoxPlanForPromo('stillorgan-newstart')).toBeNull()
  })
  it('an unknown promo has no plan', () => {
    expect(glofoxPlanForPromo('nope')).toBeNull()
    expect(glofoxPlanForPromo('toString')).toBeNull()
    expect(glofoxPlanForPromo(undefined)).toBeNull()
  })
})
