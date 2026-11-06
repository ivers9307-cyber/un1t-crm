import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const stripe = {
  paymentMethodDomains: {
    list: vi.fn(),
    create: vi.fn(),
    validate: vi.fn(),
  },
}
vi.mock('../stripe', () => ({ getStripe: () => stripe }))
vi.mock('../log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))

const {
  normalizeCheckoutDomain,
  staticCheckoutDomains,
  listCheckoutDomains,
  ensureAccountDomains,
  registerCheckoutDomainsForAccount,
  listConnectedAccounts,
} = await import('./apple-pay-domains')

function tenantDb({ rows = [], error = null } = {}) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: error ? null : rows, error })),
      })),
    })),
  }
}

describe('normalizeCheckoutDomain', () => {
  it('lower-cases and strips scheme, port and path', () => {
    expect(normalizeCheckoutDomain('HTTPS://Un1tDublin.com:443/event-pay/x')).toBe('un1tdublin.com')
  })
  it('refuses hosts Stripe can never verify', () => {
    for (const h of ['localhost', 'localhost:3000', 'app.localhost', 'x.test', '127.0.0.1', 'my-pr-123.vercel.app', '', null]) {
      expect(normalizeCheckoutDomain(h)).toBeNull()
    }
  })
})

describe('staticCheckoutDomains', () => {
  const env = { ...process.env }
  beforeEach(() => {
    delete process.env.CRM_HOSTNAMES
    delete process.env.MARKETING_HOSTNAMES
    delete process.env.HOST_PORTAL_HOSTNAME
    delete process.env.PAY_HOSTNAME
    process.env.NEXT_PUBLIC_APP_URL = 'https://some-preview.vercel.app'
  })
  afterEach(() => { process.env = { ...env } })

  it('carries the CRM hosts and every brand host that serves a checkout', () => {
    const d = staticCheckoutDomains()
    expect(d).toEqual(expect.arrayContaining([
      'crm.repset.ie', 'crm.un1tdublin.com', 'un1tdublin.com', 'www.un1tdublin.com', 'host.un1tdublin.com',
    ]))
  })
  it('leaves out brand hosts with no checkout path and preview hosts', () => {
    const d = staticCheckoutDomains()
    expect(d).not.toContain('pay.ccfautos.com')     // deposit pages only
    expect(d).not.toContain('giversautos.com')      // marketing only
    expect(d).not.toContain('some-preview.vercel.app')
  })
})

describe('listCheckoutDomains', () => {
  it('adds the active tenant domains', async () => {
    const db = tenantDb({ rows: [{ hostname: 'UN1T-Group.repset.ie' }, { hostname: 'localhost' }] })
    const { domains, tenantReadFailed } = await listCheckoutDomains(db)
    expect(tenantReadFailed).toBe(false)
    expect(domains).toContain('un1t-group.repset.ie')
    expect(domains).not.toContain('localhost')
  })
  it('a failed tenant read keeps the in-code set and says so', async () => {
    const { domains, tenantReadFailed } = await listCheckoutDomains(tenantDb({ error: { message: 'boom' } }))
    expect(tenantReadFailed).toBe(true)
    expect(domains).toContain('crm.repset.ie')
  })
})

describe('ensureAccountDomains', () => {
  beforeEach(() => {
    stripe.paymentMethodDomains.list.mockReset()
    stripe.paymentMethodDomains.create.mockReset()
    stripe.paymentMethodDomains.validate.mockReset()
  })

  it('creates missing domains, re-validates inactive ones and leaves active ones alone, all on the connected account', async () => {
    stripe.paymentMethodDomains.list.mockResolvedValue({
      data: [
        { id: 'pmd_a', domain_name: 'un1tdublin.com', apple_pay: { status: 'active' } },
        { id: 'pmd_b', domain_name: 'host.un1tdublin.com', apple_pay: { status: 'inactive' } },
      ],
      has_more: false,
    })
    stripe.paymentMethodDomains.create.mockResolvedValue({ id: 'pmd_c', apple_pay: { status: 'active' } })
    stripe.paymentMethodDomains.validate.mockResolvedValue({ id: 'pmd_b', apple_pay: { status: 'active' } })

    const res = await ensureAccountDomains('acct_1', ['un1tdublin.com', 'host.un1tdublin.com', 'crm.repset.ie'])

    expect(res.ok).toBe(true)
    expect(res.results).toEqual([
      { domain: 'un1tdublin.com', action: 'exists', applePay: 'active' },
      { domain: 'host.un1tdublin.com', action: 'revalidated', applePay: 'active' },
      { domain: 'crm.repset.ie', action: 'created', applePay: 'active' },
    ])
    expect(stripe.paymentMethodDomains.list).toHaveBeenCalledWith({ limit: 100 }, { stripeAccount: 'acct_1' })
    expect(stripe.paymentMethodDomains.create).toHaveBeenCalledWith(
      { domain_name: 'crm.repset.ie', enabled: true }, { stripeAccount: 'acct_1' },
    )
    expect(stripe.paymentMethodDomains.validate).toHaveBeenCalledWith('pmd_b', {}, { stripeAccount: 'acct_1' })
  })

  it('pages through the account\'s domains', async () => {
    stripe.paymentMethodDomains.list
      .mockResolvedValueOnce({ data: [{ id: 'pmd_1', domain_name: 'a.example.com', apple_pay: { status: 'active' } }], has_more: true })
      .mockResolvedValueOnce({ data: [{ id: 'pmd_2', domain_name: 'b.example.com', apple_pay: { status: 'active' } }], has_more: false })
    const res = await ensureAccountDomains('acct_1', ['a.example.com', 'b.example.com'])
    expect(res.results.map((r) => r.action)).toEqual(['exists', 'exists'])
    expect(stripe.paymentMethodDomains.list).toHaveBeenLastCalledWith(
      { limit: 100, starting_after: 'pmd_1' }, { stripeAccount: 'acct_1' },
    )
    expect(stripe.paymentMethodDomains.create).not.toHaveBeenCalled()
  })

  it('one failed create is reported and the rest still run', async () => {
    stripe.paymentMethodDomains.list.mockResolvedValue({ data: [], has_more: false })
    stripe.paymentMethodDomains.create
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ id: 'pmd_2', apple_pay: { status: 'active' } })
    const res = await ensureAccountDomains('acct_1', ['a.example.com', 'b.example.com'])
    expect(res.ok).toBe(false)
    expect(res.results).toEqual([
      { domain: 'a.example.com', action: 'failed', applePay: null, error: 'rate limited' },
      { domain: 'b.example.com', action: 'created', applePay: 'active' },
    ])
  })

  it('an inactive status after a successful call is reported, not a failure', async () => {
    stripe.paymentMethodDomains.list.mockResolvedValue({ data: [], has_more: false })
    stripe.paymentMethodDomains.create.mockResolvedValue({ id: 'pmd_1', apple_pay: { status: 'inactive' } })
    const res = await ensureAccountDomains('acct_1', ['a.example.com'])
    expect(res.ok).toBe(true)
    expect(res.results[0]).toEqual({ domain: 'a.example.com', action: 'created', applePay: 'inactive' })
  })

  it('a failed list is a failure with no writes', async () => {
    stripe.paymentMethodDomains.list.mockRejectedValue(new Error('no access'))
    const res = await ensureAccountDomains('acct_1', ['a.example.com'])
    expect(res).toEqual({ ok: false, error: 'no access', results: [] })
    expect(stripe.paymentMethodDomains.create).not.toHaveBeenCalled()
  })

  it('no account id is refused without calling Stripe', async () => {
    const res = await ensureAccountDomains(null, ['a.example.com'])
    expect(res.ok).toBe(false)
    expect(stripe.paymentMethodDomains.list).not.toHaveBeenCalled()
  })
})

describe('registerCheckoutDomainsForAccount', () => {
  it('never throws when Stripe does', async () => {
    stripe.paymentMethodDomains.list.mockReset().mockRejectedValue(new Error('down'))
    const res = await registerCheckoutDomainsForAccount(tenantDb(), 'acct_1')
    expect(res.ok).toBe(false)
  })
})

describe('listConnectedAccounts', () => {
  function accountsDb({ hosts = [], locs = [], hostErr = null, locErr = null } = {}) {
    return {
      from: vi.fn((table) => ({
        select: vi.fn(() => ({
          not: vi.fn(async () => (table === 'event_hosts'
            ? { data: hostErr ? null : hosts, error: hostErr }
            : { data: locErr ? null : locs, error: locErr })),
        })),
      })),
    }
  }

  it('lists host and studio accounts once each', async () => {
    const db = accountsDb({
      hosts: [{ id: 'h1', stripe_connected_account_id: 'acct_h' }],
      locs: [{ id: 'l1', acct: 'acct_l' }, { id: 'l2', acct: 'acct_h' }],
    })
    expect(await listConnectedAccounts(db)).toEqual([
      { accountId: 'acct_h', kind: 'host', id: 'h1' },
      { accountId: 'acct_l', kind: 'location', id: 'l1' },
    ])
  })

  it('a failed read throws rather than answering "no accounts"', async () => {
    await expect(listConnectedAccounts(accountsDb({ hostErr: { message: 'x' } }))).rejects.toThrow('event_hosts read failed')
    await expect(listConnectedAccounts(accountsDb({ locErr: { message: 'y' } }))).rejects.toThrow('locations read failed')
  })
})
