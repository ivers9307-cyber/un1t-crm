// MIAHATCH.2 — fakes for the un1t.online member reads (Task 4) and writes.
// Nothing here talks to un1t.online. Fictional ids only (the repo is public).
import { vi } from 'vitest'
import { Un1tApiError } from '@/lib/un1t-online'
import { Un1tBudgetSpent } from './un1t-member-read'

/**
 * Stand-in for the object openUn1tMemberReader resolves. getOne routes by
 * path: .../bookings, .../ledger, .../history answer the matching list, and
 * /credits/ledgers/{userId}/{studioId} answers `ledger` as given (an object
 * such as { balance, is_unlimited } for fetchLiveEntitlement);
 * listAll answers the same list as { rows, total, truncated } (`truncated` option).
 *
 * `fail` makes every read fail: a number is an HTTP status (Un1tApiError),
 * 'budget' is a spent budget (Un1tBudgetSpent), anything else a network fault.
 * `calls` records each path asked for.
 */
export function fakeUn1tReader({ bookings = [], ledger = [], history = [], fail = null, truncated = false, studioId = 'studio-test-1' } = {}) {
  const calls = []
  const answer = (path) => {
    if (fail === 'budget') throw new Un1tBudgetSpent('un1t read budget spent')
    if (typeof fail === 'number') throw new Un1tApiError(`un1t.online answered HTTP ${fail}`, { status: fail })
    if (fail) throw new Un1tApiError('un1t.online request failed', { status: 0 })
    if (/^\/credits\/ledgers\//.test(path)) return ledger
    if (/\/bookings(\?|$)/.test(path)) return bookings
    if (/\/ledger(\?|$)/.test(path)) return ledger
    if (/\/history(\?|$)/.test(path)) return history
    throw new Un1tApiError('unmocked fake path', { status: 404 })
  }
  const getOne = vi.fn(async (path) => {
    calls.push(path)
    return answer(path)
  })
  // The paged read, as the real reader shapes it: { rows, total, truncated }.
  const listAll = vi.fn(async (path) => {
    calls.push(path)
    const rows = answer(path)
    return { rows, total: rows.length, truncated }
  })
  return { ok: true, studioId, getOne, listAll, calls }
}

// Same shapes as the real classes in @/lib/un1t-online-write (importing the
// real module here would pull the transport into every test that mocks it).
class FakeRefused extends Error {
  constructor(code, message, result = null) {
    super(message)
    this.name = 'Un1tWriteRefused'
    this.code = code
    this.result = result
  }
}
class FakeUnknown extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'Un1tWriteUnknown'
    this.code = code
  }
}

/**
 * vi.mock factories for the un1t write side, keyed by the REAL module path:
 *
 *   const w = fakeUn1tWrite({ book: vi.fn(async () => ({ ok: false })) })
 *   vi.mock('@/lib/un1t-online-write-ops', () => w['@/lib/un1t-online-write-ops']())
 *
 * (vi.mock is hoisted, so build `w` inside vi.hoisted when you use it.) Every
 * primitive is a vi.fn that records its calls and answers { ok: true } unless
 * an override replaces it. The same fns come back from every factory call.
 */
export function fakeUn1tWrite(overrides = {}) {
  const fn = (name) => overrides[name] ?? vi.fn(async () => ({ ok: true }))
  const ops = {
    book: fn('book'),
    cancel: fn('cancel'),
    grantTrial: fn('grantTrial'),
    createCheckoutLink: fn('createCheckoutLink'),
  }
  const approval = {
    executeUn1tApproval: fn('executeUn1tApproval'),
    fileRefundCard: fn('fileRefundCard'),
  }
  const errors = {
    Un1tWriteRefused: overrides.Un1tWriteRefused ?? FakeRefused,
    Un1tWriteUnknown: overrides.Un1tWriteUnknown ?? FakeUnknown,
  }
  return {
    '@/lib/un1t-online-write': () => ({ ...errors }),
    '@/lib/un1t-online-write-ops': () => ({ ...ops }),
    '@/lib/un1t-online-approval': () => ({ ...approval }),
    fns: { ...ops, ...approval },
  }
}
