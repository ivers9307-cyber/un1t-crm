import { describe, it, expect, vi } from 'vitest'
import { resolveCustomerContact } from './customer-auth.js'

function req(token) {
  return { headers: { get: (k) => (k.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : null) } }
}
function authClient(user) {
  return { auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) } }
}
function db(contact) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: contact }) }) }) }) }
}

describe('resolveCustomerContact', () => {
  it('unauthorised when no bearer token', async () => {
    const out = await resolveCustomerContact(req(null), { authClient: authClient(null), db: db(null) })
    expect(out).toEqual({ error: 'unauthorised' })
  })

  it('unauthorised when the token does not resolve a user', async () => {
    const out = await resolveCustomerContact(req('bad'), { authClient: authClient(null), db: db({ id: 'c1' }) })
    expect(out).toEqual({ error: 'unauthorised' })
  })

  it('no_contact when token valid but no linked contact', async () => {
    const out = await resolveCustomerContact(req('t'), { authClient: authClient({ id: 'u1' }), db: db(null) })
    expect(out).toEqual({ error: 'no_contact' })
  })

  it('resolves the contact for a valid member token', async () => {
    const c = { id: 'c1', location_id: 'loc1', max_hr_override: null, dob: null }
    const out = await resolveCustomerContact(req('t'), { authClient: authClient({ id: 'u1' }), db: db(c) })
    expect(out).toEqual({ contact: c })
  })
})
