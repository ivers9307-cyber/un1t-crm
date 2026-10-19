// UN1TWRITE.20 — find, link or create a person's un1t.online account, and the
// set-password step. The write primitives and the email are mocked; the fake
// database models only what the module reads and writes.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { findUn1tAccount, ensureUn1tAccount, runSetPasswordStep } from './un1t-online-account'
import { ilikeMatches } from './like-escape.test-helpers'

const LOC = 'loc-1'
const ORG = 'org-1'
const contact = (over = {}) => ({ id: 'c-funnel', organization_id: ORG, email: ' jane@x.ie', first_name: 'Jane', last_name: 'Doe', name: 'Jane Doe', phone: null, un1t_user_id: null, ...over })
const accepted = { terms_accepted_at: '2026-10-18T09:00:00.000Z', terms_source: 'website', terms_version: 'v' }

let tables
let writes
function makeDb() {
  return {
    from(table) {
      const q = { f: [], op: 'select', payload: null }
      const rows = () => (tables[table] || []).filter((r) => q.f.every(([k, c, v]) => {
        if (k === 'eq') return r[c] === v
        if (k === 'neq') return r[c] !== v
        if (k === 'in') return v.includes(r[c])
        if (k === 'ilike') return ilikeMatches(r[c], v)
        if (k === 'notnull') return r[c] != null
        return true
      }))
      const b = {
        select: () => b, order: () => b, limit: () => b,
        eq: (c, v) => { q.f.push(['eq', c, v]); return b },
        neq: (c, v) => { q.f.push(['neq', c, v]); return b },
        in: (c, v) => { q.f.push(['in', c, v]); return b },
        ilike: (c, v) => { q.f.push(['ilike', c, v]); return b },
        not: (c) => { q.f.push(['notnull', c]); return b },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (ok, no) => Promise.resolve({ data: rows(), error: null }).then(ok, no),
      }
      return b
    },
  }
}

const done = (over) => ({ verdict: 'done', sent: true, id: null, code: null, message: null, alreadyBooked: false, retryable: false, ledgerId: 'l-1', ...over })
let deps
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test: real network call') }))
  writes = []
  tables = { contacts: [], un1t_clients: [], un1t_write_events: [] }
  deps = {
    writerFactory: vi.fn(async () => ({ locationId: LOC })),
    findClientByEmail: vi.fn(async () => ({ matches: [] })),
    createClient: vi.fn(async () => ({ ...done({ id: 'usr-new' }), conflict: null })),
    forgotPassword: vi.fn(async () => done()),
    linkAccount: vi.fn(async (db, { un1tUserId }) => { writes.push(['link', un1tUserId]); return { ok: true } }),
    sendUn1tAccountEmail: vi.fn(async () => ({ sent: true, channel: 'email' })),
  }
})

describe('findUn1tAccount', () => {
  it('own link first', async () => {
    tables.un1t_clients = [{ location_id: LOC, un1t_user_id: 'usr-own' }]
    const out = await findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact({ un1t_user_id: 'usr-own' }) }, deps)
    expect(out).toEqual({ kind: 'linked', un1tUserId: 'usr-own', executingContactId: 'c-funnel' })
    expect(deps.findClientByEmail).not.toHaveBeenCalled()
  })

  it('a sibling with the same email becomes the executing contact; a phone-only sibling is never used', async () => {
    tables.contacts = [
      { id: 'c-sib', organization_id: ORG, email: 'Jane@X.ie', phone: null, un1t_user_id: 'usr-sib' },
      { id: 'c-phone', organization_id: ORG, email: 'other@x.ie', phone: '+353800000000', un1t_user_id: 'usr-phone' },
    ]
    tables.un1t_clients = [{ location_id: LOC, un1t_user_id: 'usr-sib' }, { location_id: LOC, un1t_user_id: 'usr-phone' }]
    const out = await findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact({ phone: '+353800000000' }) }, deps)
    expect(out).toEqual({ kind: 'linked', un1tUserId: 'usr-sib', executingContactId: 'c-sib' })
  })

  it("email match is trimmed and case-insensitive exact; jane_x@x.ie never matches jane@x.ie (RF3)", async () => {
    tables.contacts = [{ id: 'c-look', organization_id: ORG, email: 'jane_x@x.ie', un1t_user_id: 'usr-look' }]
    tables.un1t_clients = [{ location_id: LOC, un1t_user_id: 'usr-look' }]
    const out = await findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact({ email: 'jane@x.ie' }) }, deps)
    expect(out).toEqual({ kind: 'none' })
    expect(deps.findClientByEmail).toHaveBeenCalledWith(expect.anything(), 'jane@x.ie')
  })

  it('API walk: one links the funnel contact, several is ambiguous, a failed walk throws', async () => {
    deps.findClientByEmail.mockResolvedValueOnce({ matches: ['usr-api'] })
    expect(await findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact() }, deps))
      .toEqual({ kind: 'linked', un1tUserId: 'usr-api', executingContactId: 'c-funnel' })
    expect(writes).toEqual([['link', 'usr-api']])
    deps.findClientByEmail.mockResolvedValueOnce({ matches: ['a', 'b'] })
    expect(await findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact() }, deps)).toEqual({ kind: 'ambiguous' })
    deps.findClientByEmail.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'api' }))
    await expect(findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact() }, deps)).rejects.toThrow('down')
  })

  it('a walk cut short by the page cap is ambiguous (staff sort it), never "none"', async () => {
    deps.findClientByEmail.mockRejectedValueOnce(Object.assign(new Error('cut short'), { code: 'truncated' }))
    expect(await findUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact() }, deps)).toEqual({ kind: 'ambiguous' })
  })
})

describe('ensureUn1tAccount', () => {
  const run = (over = {}) => ensureUn1tAccount(makeDb(), { locationId: LOC, organizationId: ORG, contact: contact(), request: { id: 'q-1', ...accepted }, origin: 'funnel', originRef: 'q-1', actor: null, ...over }, deps)

  it('no acceptance never creates and returns terms_not_accepted', async () => {
    expect(await run({ request: { id: 'q-1', terms_accepted_at: null } })).toEqual({ kind: 'card', reason: 'terms_not_accepted' })
    expect(deps.createClient).not.toHaveBeenCalled()
  })

  it('no account: create with the request\'s acceptance', async () => {
    expect(await run()).toEqual({ kind: 'created', un1tUserId: 'usr-new', executingContactId: 'c-funnel' })
    expect(deps.createClient.mock.calls[0][1]).toMatchObject({ locationId: LOC, terms: { acceptedAt: accepted.terms_accepted_at, source: 'website', version: 'v' }, origin: 'funnel', originRef: 'q-1' })
  })

  it('email in use: walk again links one, else un1t_email_in_use_elsewhere', async () => {
    deps.createClient.mockResolvedValue({ ...done({ verdict: 'refused', code: 'EMAIL_IN_USE', message: 'Email already in use' }), conflict: null })
    deps.findClientByEmail.mockResolvedValueOnce({ matches: [] }).mockResolvedValueOnce({ matches: ['usr-x'] })
    expect(await run()).toEqual({ kind: 'existing', un1tUserId: 'usr-x', executingContactId: 'c-funnel' })
    deps.findClientByEmail.mockResolvedValue({ matches: [] })
    expect(await run()).toEqual({ kind: 'card', reason: 'un1t_email_in_use_elsewhere' })
  })

  it('other refusals, unknown, a link conflict and retryable codes', async () => {
    deps.createClient.mockResolvedValueOnce({ ...done({ verdict: 'refused', code: 'BAD_PHONE' }), conflict: null })
    expect(await run()).toEqual({ kind: 'card', reason: 'un1t_create_failed:BAD_PHONE' })
    deps.createClient.mockResolvedValueOnce({ ...done({ verdict: 'unknown' }), conflict: null })
    expect(await run()).toEqual({ kind: 'card', reason: 'un1t_outcome_unknown' })
    deps.createClient.mockResolvedValueOnce({ ...done({ id: 'usr-new' }), conflict: 'un1t_link_conflict' })
    expect(await run()).toEqual({ kind: 'card', reason: 'un1t_link_conflict' })
    deps.createClient.mockResolvedValueOnce({ ...done({ verdict: 'refused', code: 'UN1T_ATTEMPT_IN_FLIGHT', retryable: true }), conflict: null })
    expect(await run()).toEqual({ kind: 'retry', code: 'UN1T_ATTEMPT_IN_FLIGHT' })
    deps.createClient.mockResolvedValueOnce({ ...done({ verdict: 'refused', code: 'UN1T_PERMISSIONS_UNREADABLE', retryable: true }), conflict: null })
    expect(await run()).toEqual({ kind: 'retry', code: 'UN1T_PERMISSIONS_UNREADABLE' })
  })

  it('an existing account needs no acceptance', async () => {
    tables.un1t_clients = [{ location_id: LOC, un1t_user_id: 'usr-own' }]
    expect(await run({ contact: contact({ un1t_user_id: 'usr-own' }), request: { id: 'q-1', terms_accepted_at: null } }))
      .toEqual({ kind: 'existing', un1tUserId: 'usr-own', executingContactId: 'c-funnel' })
  })
})

describe('runSetPasswordStep — never promises a code twice', () => {
  const createdRow = { id: 'w-1', location_id: LOC, contact_id: 'c-funnel', op: 'create_client', stage: 'done', un1t_ref: 'usr-new', created_at: '2026-10-18T09:00:00Z' }
  const resetRow = (stage) => ({ id: `w-r-${stage}`, location_id: LOC, op: 'forgot_password', stage, idempotency_key: `pw:${LOC}:usr-new`, created_at: '2026-10-18T09:01:00Z' })
  const step = (over = {}) => runSetPasswordStep(makeDb(), { locationId: LOC, contact: contact({ email: 'jane@x.ie' }), un1tUserId: 'usr-new', request: { id: 'q-1' }, settings: { sendsWelcome: false, welcomeSetsLogin: false }, origin: 'funnel', ...over }, deps)

  it('an in-doubt reset sends neither our email nor another request', async () => {
    for (const stage of ['sent', 'unknown']) {
      tables.un1t_write_events = [createdRow, resetRow(stage)]
      expect(await step()).toMatchObject({ explanation: 'skipped_reset_in_doubt', forgotPassword: 'in_doubt' })
    }
    expect(deps.sendUn1tAccountEmail).not.toHaveBeenCalled()
    expect(deps.forgotPassword).not.toHaveBeenCalled()
  })

  it('a refused earlier reset is tried again, without our email again', async () => {
    tables.un1t_write_events = [createdRow, resetRow('refused')]
    expect(await step()).toEqual({ explanation: 'skipped_already_sent', forgotPassword: 'done' })
    expect(deps.sendUn1tAccountEmail).not.toHaveBeenCalled()
  })

  it('a budget or permission refusal before anything is sent defers both', async () => {
    tables.un1t_write_events = [createdRow]
    const { Un1tWriteRefused } = await import('./un1t-online-write.js')
    const writer = { ensureOp: vi.fn(async () => { throw new Un1tWriteRefused('UN1T_RATE_BUDGET', 'busy', { retryable: true }) }) }
    expect(await step({ writer })).toMatchObject({ explanation: 'deferred', forgotPassword: 'retry', code: 'UN1T_RATE_BUDGET' })
    expect(deps.sendUn1tAccountEmail).not.toHaveBeenCalled()
  })
})

describe('runSetPasswordStep', () => {
  const createdRow = { id: 'w-1', location_id: LOC, contact_id: 'c-other', op: 'create_client', stage: 'done', un1t_ref: 'usr-new', created_at: '2026-10-18T09:00:00Z' }
  const resetRow = (stage) => ({ id: `w-r-${stage}`, location_id: LOC, op: 'forgot_password', stage, idempotency_key: `pw:${LOC}:usr-new`, created_at: '2026-10-18T09:01:00Z' })
  const settings = (over = {}) => ({ sendsWelcome: false, welcomeSetsLogin: false, ...over })
  const step = (over = {}) => runSetPasswordStep(makeDb(), { locationId: LOC, contact: contact({ email: 'jane@x.ie' }), un1tUserId: 'usr-new', request: { id: 'q-1', class_name: 'RALLY', starts_at: '2026-10-20T18:00:00Z' }, settings: settings(), origin: 'funnel', emailArgs: { blocks: [], studioName: 'Hatch', address: null, zone: 'Europe/Dublin' }, ...over }, deps)

  it('explanation email then forgot-password, in that order', async () => {
    tables.un1t_write_events = [createdRow]
    const order = []
    deps.sendUn1tAccountEmail.mockImplementation(async () => { order.push('email'); return { sent: true, channel: 'email' } })
    deps.forgotPassword.mockImplementation(async () => { order.push('forgot'); return done() })
    expect(await step()).toEqual({ explanation: 'sent', forgotPassword: 'done' })
    expect(order).toEqual(['email', 'forgot'])
    // The created-by-us check matches the user, whichever contact the create was for.
    expect(deps.forgotPassword.mock.calls[0][1]).toMatchObject({ un1tUserId: 'usr-new', email: 'jane@x.ie', contactId: 'c-funnel', origin: 'funnel' })
  })

  it('existing accounts get no set-password step', async () => {
    expect(await step()).toEqual({ explanation: 'skipped_not_created', forgotPassword: 'skipped_not_created' })
    expect(deps.forgotPassword).not.toHaveBeenCalled()
    expect(deps.sendUn1tAccountEmail).not.toHaveBeenCalled()
  })

  it('a done forgot-password is never repeated', async () => {
    tables.un1t_write_events = [createdRow, { id: 'w-2', location_id: LOC, op: 'forgot_password', stage: 'done', idempotency_key: `pw:${LOC}:usr-new`, created_at: '2026-10-18T09:01:00Z' }]
    expect(await step()).toEqual({ explanation: 'skipped_already_done', forgotPassword: 'skipped_already_done' })
    expect(deps.forgotPassword).not.toHaveBeenCalled()
  })

  it('sendsWelcome skips our email; sendsWelcome + welcomeSetsLogin skips the call too; each skip is reported', async () => {
    tables.un1t_write_events = [createdRow]
    expect(await step({ settings: settings({ sendsWelcome: true }) })).toEqual({ explanation: 'skipped_flag', forgotPassword: 'done' })
    expect(deps.sendUn1tAccountEmail).not.toHaveBeenCalled()
    expect(await step({ settings: settings({ sendsWelcome: true, welcomeSetsLogin: true }) })).toEqual({ explanation: 'skipped_flag', forgotPassword: 'skipped_flag' })
  })

  it('our email failing never blocks the call; a refused or unclear reset is reported', async () => {
    tables.un1t_write_events = [createdRow]
    deps.sendUn1tAccountEmail.mockResolvedValueOnce({ sent: false, channel: 'email', reason: 'email_blocked' })
    expect(await step()).toEqual({ explanation: 'email_blocked', forgotPassword: 'done' })
    deps.forgotPassword.mockResolvedValueOnce(done({ verdict: 'unknown' }))
    expect(await step()).toMatchObject({ forgotPassword: 'unknown', help: expect.stringMatching(/Forgot password/) })
    deps.forgotPassword.mockResolvedValueOnce(done({ verdict: 'refused', code: 'UN1T_RATE_BUDGET', retryable: true }))
    expect(await step()).toMatchObject({ forgotPassword: 'retry', code: 'UN1T_RATE_BUDGET' })
    deps.sendUn1tAccountEmail.mockRejectedValueOnce(new Error('boom'))
    expect((await step()).explanation).toBe('send_error')
  })
})
