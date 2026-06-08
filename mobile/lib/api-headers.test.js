import { describe, it, expect } from 'vitest'
import { buildAuthHeaders } from './api-headers'

describe('buildAuthHeaders', () => {
  it('attaches x-impersonate-target when a View-as target is active', () => {
    const h = buildAuthHeaders({ token: 'jwt', impersonateTargetId: 'target-uuid' })
    expect(h['x-impersonate-target']).toBe('target-uuid')
    expect(h.Authorization).toBe('Bearer jwt')
    expect(h.Accept).toBe('application/json')
  })

  it('omits x-impersonate-target when not impersonating', () => {
    const h = buildAuthHeaders({ token: 'jwt' })
    expect(h).not.toHaveProperty('x-impersonate-target')
  })

  it('omits Authorization when there is no token (logged-out / cold start)', () => {
    expect(buildAuthHeaders({})).not.toHaveProperty('Authorization')
  })

  it('adds Content-Type only when json:true (multipart must keep RN’s own boundary)', () => {
    expect(buildAuthHeaders({ token: 't' })).not.toHaveProperty('Content-Type')
    expect(buildAuthHeaders({ token: 't', json: true })['Content-Type']).toBe('application/json')
  })

  it('adds x-active-location only when a locationId override is given', () => {
    expect(buildAuthHeaders({ token: 't', locationId: 'loc-1' })['x-active-location']).toBe('loc-1')
    expect(buildAuthHeaders({ token: 't' })).not.toHaveProperty('x-active-location')
  })
})
