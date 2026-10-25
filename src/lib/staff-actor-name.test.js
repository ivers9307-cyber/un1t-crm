import { describe, it, expect } from 'vitest'
import { staffActorName } from './staff-actor-name'

describe('staffActorName', () => {
  it('the staff member, by name then email, else "staff"', () => {
    expect(staffActorName({ full_name: 'Sam Staff', email: 'sam@example.test' })).toBe('Sam Staff')
    expect(staffActorName({ email: 'sam@example.test' })).toBe('sam@example.test')
    expect(staffActorName({})).toBe('staff')
    expect(staffActorName(null)).toBe('staff')
  })
  it('under impersonation, the REAL caller: "<master> as <user>"', () => {
    expect(staffActorName({ full_name: 'Sam', impersonatingFrom: { masterId: 'm1', masterName: 'Rich' } })).toBe('Rich as Sam')
    expect(staffActorName({ full_name: 'Sam', impersonatingFrom: { masterId: 'm1', masterEmail: 'r@example.test' } })).toBe('r@example.test as Sam')
    expect(staffActorName({ full_name: 'Sam', impersonatingFrom: { masterId: 'm1' } })).toBe('master as Sam')
  })
})
