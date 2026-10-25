// ADOPTDOMAIN.1 — "Domain already exists" on provision.
//
// Live 11 Oct 2026: a master provisioned UN1T Group's sending domain with the
// platform's own domain. The org's Postmark server was created and its
// webhooks registered, then POST /domains answered "Domain already exists."
// because Postmark domains are ACCOUNT resources (a name exists once) and the
// platform's account already held it. The row stayed 'pending' with no domain.
//
// provisionEmailDomain now adopts the existing account domain, but only when
// the caller is a platform MASTER and no OTHER organisation's row holds that
// domain (by name or Postmark id). Anything else refuses with an
// operator-neutral message. Every Postmark call is mocked; all ids synthetic.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getOwnerOrganizationIds: () => [] }))
vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/postmark-account', async () => {
  const actual = await vi.importActual('@/lib/postmark-account')
  return {
    // Pure helpers stay real (the error matcher and the status rule).
    isDomainAlreadyExistsError: actual.isDomainAlreadyExistsError,
    domainIsFullyVerified: actual.domainIsFullyVerified,
    createTenantServer: vi.fn(),
    createTenantDomain: vi.fn(),
    findTenantDomainByName: vi.fn(),
    getTenantDomain: vi.fn(),
    verifyTenantDomainDkim: vi.fn(),
    verifyTenantReturnPath: vi.fn(),
    ensureTenantServerStreams: vi.fn(),
    ensureTenantServerWebhooks: vi.fn(),
  }
})

import {
  provisionEmailDomain,
  EMAIL_DOMAIN_TAKEN_CODE,
  EMAIL_DOMAIN_CLAIM_CHECK_FAILED,
} from './email-domain-service.js'
import {
  createTenantServer,
  createTenantDomain,
  findTenantDomainByName,
  getTenantDomain,
  ensureTenantServerStreams,
  ensureTenantServerWebhooks,
} from '@/lib/postmark-account'
import { ilikeMatches } from './like-escape.test-helpers.js'

const ORG = 'org-a'
const DOMAIN = 'gyma.example'
const TAKEN = `This domain is already registered on the platform. Use a subdomain such as mail.${DOMAIN}, or contact support.`

// The refusal exactly as accountRequest throws it.
function alreadyExists() {
  const e = new Error('Postmark account API error: Domain already exists.')
  e.status = 422
  e.postmarkErrorCode = 505
  e.postmarkMessage = 'Domain already exists.'
  return e
}

// Stateful fake of tenant_email_domains: this org's row (load + upsert) plus
// OTHER orgs' rows, queried by the claim check through
// select → eq/ilike → neq → limit (awaited).
function fakeDb(initialRow, otherRows = [], { claimError = null } = {}) {
  const state = { row: initialRow ? { ...initialRow } : null, patches: [], claimQueries: [] }
  const db = {
    state,
    from: (table) => {
      expect(table).toBe('tenant_email_domains')
      return {
        select: (cols) => {
          const filters = []
          const builder = {
            eq: (col, val) => { filters.push((r) => r[col] === val); return builder },
            neq: (col, val) => { filters.push((r) => r[col] !== val); return builder },
            // Real ILIKE semantics (wildcards + escapes), not lower(a)===lower(b).
            ilike: (col, pat) => { filters.push((r) => typeof r[col] === 'string' && ilikeMatches(pat, r[col])); return builder },
            limit: () => builder,
            maybeSingle: async () => ({ data: state.row, error: null }),
            then: (resolve) => {
              state.claimQueries.push(cols)
              if (claimError) return resolve({ data: null, error: claimError })
              return resolve({ data: otherRows.filter((r) => filters.every((f) => f(r))).map((r) => ({ organization_id: r.organization_id })), error: null })
            },
          }
          return builder
        },
        upsert: (patch) => {
          state.patches.push(patch)
          state.row = { ...(state.row || {}), ...patch }
          return { select: () => ({ single: async () => ({ data: state.row, error: null }) }) }
        },
      }
    },
  }
  return db
}

// The row as it is live now: server minted, webhooks stamped, no domain.
const PENDING_ROW = {
  organization_id: ORG, postmark_server_id: 21100951, postmark_server_token: 'srv-tok',
  webhooks_registered_at: '2026-10-11T09:00:00.000Z', postmark_domain_id: null, sending_domain: null,
  status: 'pending', last_error: 'Postmark account API error: Domain already exists.',
}

const VERIFIED = {
  id: 4242, dkimPendingHost: '20261011pm._domainkey.gyma.example', dkimPendingValue: 'k=rsa;p=VERIFIED',
  dkimVerified: true, returnPathDomain: 'pm-bounces.gyma.example', returnPathCnameValue: 'pm.mtasv.net',
  returnPathVerified: true,
}
const DKIM_PENDING = { ...VERIFIED, dkimPendingValue: 'k=rsa;p=PENDING', dkimVerified: false }

const ARGS = { orgId: ORG, orgName: 'UN1T Group', sendingDomain: DOMAIN, fromLocal: 'Sales', fromName: 'UN1T', createdBy: 'u-1' }

beforeEach(() => {
  vi.clearAllMocks()
  createTenantServer.mockResolvedValue({ id: 999, serverToken: 'NEW-srv-tok' })
  createTenantDomain.mockRejectedValue(alreadyExists())
  findTenantDomainByName.mockResolvedValue({ ID: 4242, Name: DOMAIN })
  getTenantDomain.mockResolvedValue(VERIFIED)
  ensureTenantServerStreams.mockResolvedValue({ created: false })
  ensureTenantServerWebhooks.mockResolvedValue({ created: [] })
})

describe('ADOPTDOMAIN.1 — master + unclaimed: adopt the existing account domain', () => {
  it('both records verified → live, ids + DNS stored, last_error cleared, from-address lower-cased', async () => {
    const db = fakeDb(PENDING_ROW)
    const row = await provisionEmailDomain(db, { ...ARGS, isMaster: true })

    expect(createTenantDomain).toHaveBeenCalledWith(DOMAIN)
    expect(findTenantDomainByName).toHaveBeenCalledWith(DOMAIN)
    expect(getTenantDomain).toHaveBeenCalledWith(4242)
    expect(row).toMatchObject({
      postmark_domain_id: 4242,
      sending_domain: DOMAIN,
      from_email: `sales@${DOMAIN}`,
      from_name: 'UN1T',
      dkim_pending_host: VERIFIED.dkimPendingHost,
      dkim_pending_value: VERIFIED.dkimPendingValue,
      dkim_verified: true,
      return_path_domain: VERIFIED.returnPathDomain,
      return_path_cname_value: VERIFIED.returnPathCnameValue,
      return_path_verified: true,
      status: 'live',
      last_error: null,
    })
    // Both claim queries ran (by id and by name).
    expect(db.state.claimQueries).toHaveLength(2)
  })

  it('DKIM still pending → not live (verifying: domain known, DNS unconfirmed), with the records to add', async () => {
    getTenantDomain.mockResolvedValue(DKIM_PENDING)
    const db = fakeDb(PENDING_ROW)
    const row = await provisionEmailDomain(db, { ...ARGS, isMaster: true })
    expect(row.status).toBe('verifying')
    expect(row.status).not.toBe('live')
    expect(row).toMatchObject({
      postmark_domain_id: 4242,
      dkim_verified: false,
      return_path_verified: true,
      dkim_pending_host: DKIM_PENDING.dkimPendingHost,
      dkim_pending_value: 'k=rsa;p=PENDING',
      last_error: null,
    })
  })

  it('a row whose own sending_domain is already this domain is not "another org"', async () => {
    const db = fakeDb({ ...PENDING_ROW, sending_domain: DOMAIN })
    const row = await provisionEmailDomain(db, { ...ARGS, isMaster: true })
    expect(row.postmark_domain_id).toBe(4242)
  })
})

describe('ADOPTDOMAIN.1 — refusals', () => {
  async function expectTaken(promise) {
    const err = await promise.then(() => null, (e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(EMAIL_DOMAIN_TAKEN_CODE)
    expect(err.message).toBe(TAKEN)
    return err
  }

  it('refuses a caller who is not a platform master, without looking the domain up', async () => {
    const db = fakeDb(PENDING_ROW)
    await expectTaken(provisionEmailDomain(db, { ...ARGS, isMaster: false }))
    expect(findTenantDomainByName).not.toHaveBeenCalled()
    expect(getTenantDomain).not.toHaveBeenCalled()
    // Nothing about the domain was written to the row.
    expect(db.state.patches.some((p) => 'postmark_domain_id' in p)).toBe(false)
  })

  it('isMaster defaults to false (a caller that passes nothing never adopts)', async () => {
    const db = fakeDb(PENDING_ROW)
    await expectTaken(provisionEmailDomain(db, ARGS))
    expect(findTenantDomainByName).not.toHaveBeenCalled()
  })

  it('refuses a master when ANOTHER org holds the domain by name (any case)', async () => {
    const db = fakeDb(PENDING_ROW, [{ organization_id: 'org-b', sending_domain: 'GymA.Example', postmark_domain_id: 7 }])
    await expectTaken(provisionEmailDomain(db, { ...ARGS, isMaster: true }))
    expect(getTenantDomain).not.toHaveBeenCalled()
    expect(db.state.patches.some((p) => 'postmark_domain_id' in p)).toBe(false)
  })

  it('refuses a master when ANOTHER org holds the Postmark domain id', async () => {
    const db = fakeDb(PENDING_ROW, [{ organization_id: 'org-b', sending_domain: 'other.example', postmark_domain_id: 4242 }])
    await expectTaken(provisionEmailDomain(db, { ...ARGS, isMaster: true }))
    expect(getTenantDomain).not.toHaveBeenCalled()
  })

  it('a look-alike name is not a claim (`_`/`%` are not wildcards)', async () => {
    const db = fakeDb(PENDING_ROW, [{ organization_id: 'org-b', sending_domain: 'gymaxexample', postmark_domain_id: 7 }])
    const row = await provisionEmailDomain(db, { ...ARGS, isMaster: true, sendingDomain: 'gyma_example' })
    expect(row.postmark_domain_id).toBe(4242)
  })

  it('a failed claim check fails CLOSED (no adoption)', async () => {
    const db = fakeDb(PENDING_ROW, [], { claimError: { message: 'statement timeout' } })
    const err = await provisionEmailDomain(db, { ...ARGS, isMaster: true }).then(() => null, (e) => e)
    expect(err.message).toBe(EMAIL_DOMAIN_CLAIM_CHECK_FAILED)
    expect(err.message).not.toContain('statement timeout')
    expect(getTenantDomain).not.toHaveBeenCalled()
  })

  it('a domain the account list does not show rethrows the original Postmark error', async () => {
    findTenantDomainByName.mockResolvedValue(null)
    const db = fakeDb(PENDING_ROW)
    const err = await provisionEmailDomain(db, { ...ARGS, isMaster: true }).then(() => null, (e) => e)
    expect(err.message).toBe('Postmark account API error: Domain already exists.')
    expect(err.code).toBeUndefined()
  })
})

describe('ADOPTDOMAIN.1 — retry + unchanged paths', () => {
  it('re-running on a row that already has a server reuses it (no second server) and proceeds to the domain step', async () => {
    const db = fakeDb(PENDING_ROW)
    await provisionEmailDomain(db, { ...ARGS, isMaster: true })
    expect(createTenantServer).not.toHaveBeenCalled()
    expect(db.state.patches.some((p) => 'postmark_server_id' in p || 'postmark_server_token' in p)).toBe(false)
    expect(db.state.row.postmark_server_id).toBe(21100951)
    expect(db.state.row.postmark_server_token).toBe('srv-tok')
    // Webhooks were already stamped: not re-registered.
    expect(ensureTenantServerStreams).not.toHaveBeenCalled()
    expect(ensureTenantServerWebhooks).not.toHaveBeenCalled()
    expect(createTenantDomain).toHaveBeenCalledTimes(1)
  })

  it('an unexpected Postmark error from POST /domains is thrown unchanged (no lookup, no adoption)', async () => {
    const other = new Error('Postmark account API error: Invalid domain name.')
    other.postmarkMessage = 'Invalid domain name.'
    createTenantDomain.mockRejectedValue(other)
    const db = fakeDb(PENDING_ROW)
    const err = await provisionEmailDomain(db, { ...ARGS, isMaster: true }).then(() => null, (e) => e)
    expect(err).toBe(other)
    expect(findTenantDomainByName).not.toHaveBeenCalled()
  })

  it('a fresh domain still goes through createTenantDomain as before (no lookup)', async () => {
    createTenantDomain.mockResolvedValue({ ...DKIM_PENDING, id: 55 })
    const db = fakeDb(PENDING_ROW)
    const row = await provisionEmailDomain(db, { ...ARGS, isMaster: false })
    expect(findTenantDomainByName).not.toHaveBeenCalled()
    expect(row.postmark_domain_id).toBe(55)
    expect(row.status).toBe('verifying')
    expect(row.from_email).toBe(`sales@${DOMAIN}`)
  })
})
