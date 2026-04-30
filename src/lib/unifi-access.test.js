import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock undici BEFORE importing the module under test so the helper picks
// up the mocked fetch. Each test resets/configures `mockFetch` to return
// what it needs.
const mockFetch = vi.fn()
vi.mock('undici', () => ({
  Agent: class { /* unused — we never inspect it */ },
  fetch: (...args) => mockFetch(...args),
}))

const {
  getLocationUnifiConfig,
  policyIdForRole,
  findUnifiUserByEmail,
  createUnifiUser,
  findOrCreateUnifiUser,
  setUnifiUserPolicies,
  syncUnifiUserPolicyForRole,
  revokeUnifiUserPolicies,
  UnifiError,
} = await import('./unifi-access.js')

const cfg = {
  configured: true,
  host: 'https://example.test:12445',
  apiToken: 'tok-abc',
  staffPolicyId: 'pol-staff',
  managerPolicyId: 'pol-manager',
  allowSelfSigned: false,
}

function ok(data) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ code: 'SUCCESS', msg: 'success', data }),
  })
}
function fail(httpStatus, body) {
  return Promise.resolve({
    ok: false,
    status: httpStatus,
    statusText: 'Bad',
    json: () => Promise.resolve(body),
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('getLocationUnifiConfig', () => {
  it('flags configured=true only when all four fields are present', () => {
    expect(getLocationUnifiConfig({}).configured).toBe(false)
    expect(getLocationUnifiConfig({ settings: { unifi: { host: 'x' } } }).configured).toBe(false)
    const full = {
      settings: {
        unifi: {
          host: 'https://x:12445',
          api_token: 'tok',
          staff_policy_id: 'a',
          manager_policy_id: 'b',
        },
      },
    }
    expect(getLocationUnifiConfig(full).configured).toBe(true)
  })

  it('strips trailing slash from host so URL building stays clean', () => {
    const c = getLocationUnifiConfig({
      settings: { unifi: { host: 'https://x:12445/', api_token: 't', staff_policy_id: 's', manager_policy_id: 'm' } },
    })
    expect(c.host).toBe('https://x:12445')
  })

  it('passes through allow_self_signed only when literally true', () => {
    const t = getLocationUnifiConfig({ settings: { unifi: { allow_self_signed: true } } })
    const f1 = getLocationUnifiConfig({ settings: { unifi: { allow_self_signed: 'yes' } } })
    const f2 = getLocationUnifiConfig({ settings: { unifi: {} } })
    expect(t.allowSelfSigned).toBe(true)
    expect(f1.allowSelfSigned).toBe(false)
    expect(f2.allowSelfSigned).toBe(false)
  })
})

describe('policyIdForRole', () => {
  it('owner / manager → manager policy', () => {
    expect(policyIdForRole(cfg, 'owner')).toBe('pol-manager')
    expect(policyIdForRole(cfg, 'manager')).toBe('pol-manager')
  })

  it('head_coach / staff → staff policy', () => {
    expect(policyIdForRole(cfg, 'head_coach')).toBe('pol-staff')
    expect(policyIdForRole(cfg, 'staff')).toBe('pol-staff')
  })

  it('returns null when config is incomplete', () => {
    expect(policyIdForRole({ configured: false }, 'manager')).toBeNull()
    expect(policyIdForRole(null, 'manager')).toBeNull()
  })
})

describe('findUnifiUserByEmail', () => {
  it('returns the exact-email match (case-insensitive)', async () => {
    mockFetch.mockReturnValueOnce(ok({
      users: [
        { id: 'u1', user_email: 'OTHER@x.com' },
        { id: 'u2', user_email: 'Test@X.com' },
      ],
    }))
    const u = await findUnifiUserByEmail(cfg, 'test@x.com')
    expect(u.id).toBe('u2')
  })

  it('returns null when no email matches', async () => {
    mockFetch.mockReturnValueOnce(ok({ users: [{ id: 'u1', user_email: 'other@x.com' }] }))
    const u = await findUnifiUserByEmail(cfg, 'me@x.com')
    expect(u).toBeNull()
  })

  it('handles array-of-users response shape (older API revs)', async () => {
    mockFetch.mockReturnValueOnce(ok([{ id: 'u9', user_email: 'me@x.com' }]))
    const u = await findUnifiUserByEmail(cfg, 'me@x.com')
    expect(u.id).toBe('u9')
  })

  it('returns null fast for empty email', async () => {
    expect(await findUnifiUserByEmail(cfg, '')).toBeNull()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('createUnifiUser', () => {
  it('posts the expected payload and returns the created user', async () => {
    mockFetch.mockReturnValueOnce(ok({ id: 'new-id', first_name: 'A', last_name: 'B' }))
    const user = await createUnifiUser(cfg, { firstName: 'A', lastName: 'B', email: 'a@b.com', employeeNumber: 'p-1' })
    expect(user.id).toBe('new-id')
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.test:12445/api/v1/developer/users')
    expect(init.method).toBe('POST')
    const sentBody = JSON.parse(init.body)
    expect(sentBody).toEqual({
      first_name: 'A', last_name: 'B', user_email: 'a@b.com', employee_number: 'p-1',
    })
  })

  it('refuses to create without first/last name', async () => {
    await expect(createUnifiUser(cfg, { firstName: 'A' })).rejects.toThrow(UnifiError)
  })
})

describe('findOrCreateUnifiUser', () => {
  it('returns the existing id when email matches — no create call', async () => {
    mockFetch.mockReturnValueOnce(ok({ users: [{ id: 'existing', user_email: 'a@b.com' }] }))
    const id = await findOrCreateUnifiUser(cfg, { email: 'a@b.com', full_name: 'A B' })
    expect(id).toBe('existing')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('creates when no email match exists', async () => {
    mockFetch
      .mockReturnValueOnce(ok({ users: [] }))                   // search → empty
      .mockReturnValueOnce(ok({ id: 'fresh' }))                 // create
    const id = await findOrCreateUnifiUser(cfg, { email: 'a@b.com', full_name: 'Aoife Byrne', id: 'crm-uuid' })
    expect(id).toBe('fresh')
    const [, createInit] = mockFetch.mock.calls[1]
    expect(JSON.parse(createInit.body)).toMatchObject({
      first_name: 'Aoife', last_name: 'Byrne', employee_number: 'crm-uuid',
    })
  })

  it('handles single-name profiles by duplicating the name part', async () => {
    mockFetch
      .mockReturnValueOnce(ok({ users: [] }))
      .mockReturnValueOnce(ok({ id: 'fresh' }))
    await findOrCreateUnifiUser(cfg, { email: 'x@x.com', full_name: 'Cher' })
    const sent = JSON.parse(mockFetch.mock.calls[1][1].body)
    expect(sent.first_name).toBe('Cher')
    expect(sent.last_name).toBe('Cher')
  })

  it('skips the search call when no email is given', async () => {
    mockFetch.mockReturnValueOnce(ok({ id: 'fresh' }))           // create
    const id = await findOrCreateUnifiUser(cfg, { full_name: 'No Email' })
    expect(id).toBe('fresh')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('throws if create response lacks an id', async () => {
    mockFetch
      .mockReturnValueOnce(ok({ users: [] }))
      .mockReturnValueOnce(ok({ /* no id */ }))
    await expect(findOrCreateUnifiUser(cfg, { email: 'a@b.com', full_name: 'A B' }))
      .rejects.toThrow(/did not return an id/)
  })
})

describe('setUnifiUserPolicies', () => {
  it('PUTs the policy array to /users/:id/access_policies', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await setUnifiUserPolicies(cfg, 'unifi-1', ['pol-x', 'pol-y'])
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.test:12445/api/v1/developer/users/unifi-1/access_policies')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body)).toEqual({ access_policy_ids: ['pol-x', 'pol-y'] })
  })

  it('coerces a single id to array', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await setUnifiUserPolicies(cfg, 'unifi-1', 'pol-only')
    const [, init] = mockFetch.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ access_policy_ids: ['pol-only'] })
  })

  it('URL-encodes the user id segment', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await setUnifiUserPolicies(cfg, 'a/b c', ['p'])
    const [url] = mockFetch.mock.calls[0]
    expect(url).toContain('/users/a%2Fb%20c/access_policies')
  })

  it('refuses without a user id', async () => {
    await expect(setUnifiUserPolicies(cfg, '', ['p'])).rejects.toThrow(UnifiError)
  })
})

describe('syncUnifiUserPolicyForRole', () => {
  it('assigns manager_policy_id for owner / manager', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    const id = await syncUnifiUserPolicyForRole(cfg, 'unifi-1', 'manager')
    expect(id).toBe('pol-manager')
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      access_policy_ids: ['pol-manager'],
    })
  })

  it('assigns staff_policy_id for staff / head_coach', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await syncUnifiUserPolicyForRole(cfg, 'unifi-1', 'staff')
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      access_policy_ids: ['pol-staff'],
    })
  })

  it('throws a clear error when the location is not configured', async () => {
    await expect(
      syncUnifiUserPolicyForRole({ configured: false }, 'u', 'staff')
    ).rejects.toThrow(/No UniFi policy configured/)
  })
})

describe('revokeUnifiUserPolicies', () => {
  it('PUTs an empty array, clearing all policies', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await revokeUnifiUserPolicies(cfg, 'unifi-1')
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ access_policy_ids: [] })
  })
})

describe('error mapping', () => {
  it('UniFi error response → UnifiError with code and msg', async () => {
    mockFetch.mockReturnValueOnce(Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ code: 'CODE_USER_NAME_DUPLICATED', msg: 'name in use' }),
    }))
    await expect(setUnifiUserPolicies(cfg, 'u', ['p']))
      .rejects.toThrow(/CODE_USER_NAME_DUPLICATED.*name in use/)
  })

  it('HTTP failure → UnifiError with HTTP status', async () => {
    mockFetch.mockReturnValueOnce(fail(401, { code: 'CODE_AUTH_FAILED', msg: 'bad token' }))
    await expect(setUnifiUserPolicies(cfg, 'u', ['p']))
      .rejects.toThrow(/CODE_AUTH_FAILED.*bad token/)
  })

  it('network/timeout failure → UnifiError', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(setUnifiUserPolicies(cfg, 'u', ['p']))
      .rejects.toThrow(/UniFi request failed.*ECONNREFUSED/)
  })

  it('refuses calls without a host', async () => {
    await expect(
      setUnifiUserPolicies({ apiToken: 't' }, 'u', ['p'])
    ).rejects.toThrow(/host not configured/)
  })

  it('refuses calls without a token', async () => {
    await expect(
      setUnifiUserPolicies({ host: 'https://x:12445' }, 'u', ['p'])
    ).rejects.toThrow(/API token not configured/)
  })
})

describe('auth header + URL composition', () => {
  it('sends Authorization: Bearer <token> on every call', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await revokeUnifiUserPolicies(cfg, 'u1')
    const [, init] = mockFetch.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer tok-abc')
  })

  it('attaches the insecure dispatcher only when allow_self_signed is on', async () => {
    mockFetch.mockReturnValueOnce(ok(null))
    await revokeUnifiUserPolicies({ ...cfg, allowSelfSigned: true }, 'u1')
    expect(mockFetch.mock.calls[0][1].dispatcher).toBeDefined()

    mockFetch.mockReturnValueOnce(ok(null))
    await revokeUnifiUserPolicies({ ...cfg, allowSelfSigned: false }, 'u1')
    expect(mockFetch.mock.calls[1][1].dispatcher).toBeUndefined()
  })
})
