// FINALTIDY.1 — a caller who can't see an expense claim gets the SAME 404 as
// a missing claim, on every /api/expenses/[id]/* route, so a claim id can't
// be probed for existence. A caller who CAN see it but may not act keeps the
// route's honest 403. Permissions resolve through the real
// hasPermissionForLocation; only auth, the DB and side-effect libs are mocked.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const LOC_A = 'a0000000-0000-0000-0000-000000000001'
const LOC_B = 'b0000000-0000-0000-0000-000000000002'
const CLAIM_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const ITEM_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const CLAIMANT_ID = '11111111-1111-1111-1111-111111111111'

const h = vi.hoisted(() => ({ user: null, claim: null, updated: [] }))

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(async () => h.user) }))
vi.mock('@/lib/fte-expense-lifecycle', () => ({
  withExpenseLifecycle: vi.fn(async (_db, rows) => rows.map((r) => ({ ...r, lifecycle: null }))),
}))
vi.mock('@/lib/push-dedup', () => ({
  notifyUsersOnce: vi.fn(async () => ({})),
  sendPushToRolesAtLocationOnce: vi.fn(async () => ({})),
}))
vi.mock('@/lib/invoices-queue/enqueue', () => ({
  enqueueFromFteExpenseClaim: vi.fn(async () => ({ inserted: 0, skipped: 0, errors: [] })),
}))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(async () => ({})) }))

// A permissive chain: every filter returns itself; terminal calls resolve
// the current claim (or, for an item lookup, an item wrapping it).
function chain(table) {
  const q = {
    select: () => q, eq: () => q, in: () => q, not: () => q, order: () => q, limit: () => q,
    update: (patch) => { h.updated.push({ table, patch }); return q },
    delete: () => q,
    maybeSingle: async () => {
      if (!h.claim) return { data: null, error: null }
      if (table === 'fte_expense_items') {
        return { data: { id: ITEM_ID, claim_id: CLAIM_ID, receipt_path: 'x/y/z.jpg', receipt_mime_type: 'image/jpeg', claim: h.claim }, error: null }
      }
      return { data: h.claim, error: null }
    },
    single: async () => ({ data: h.claim ? { ...h.claim, status: 'awaiting_accountant_review' } : null, error: null }),
    then: (res) => res({ data: [], error: null }),
  }
  return q
}
vi.mock('@/lib/supabase', () => ({
  createServerClient: () => ({
    from: (table) => chain(table),
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/x' }, error: null }),
        remove: async () => ({ data: null, error: null }),
      }),
    },
  }),
}))

import { GET, PATCH, DELETE } from './route.js'
import { POST as APPROVE } from './approve/route.js'
import { POST as DECLINE } from './decline/route.js'
import { POST as SUBMIT } from './submit/route.js'
import { POST as REVOKE } from './revoke/route.js'
import { POST as ADD_ITEM } from './items/route.js'
import { POST as UPLOAD_SIGN } from './upload-sign/route.js'
import { PATCH as PATCH_ITEM, DELETE as DELETE_ITEM } from './items/[itemId]/route.js'
import { GET as RECEIPT } from './items/[itemId]/receipt/route.js'

const ctx = { params: Promise.resolve({ id: CLAIM_ID }) }
const itemCtx = { params: Promise.resolve({ id: CLAIM_ID, itemId: ITEM_ID }) }
const jsonReq = (body = {}) => ({
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
})

function member(id, rolesByLoc, perms = {}) {
  return {
    id,
    role: Object.values(rolesByLoc)[0] || 'staff',
    profileRole: 'staff',
    rolesByLocation: rolesByLoc,
    locations: Object.entries(rolesByLoc).map(([lid, role]) => ({ id: lid, role, features: {} })),
    assignmentsByLocation: Object.fromEntries(
      Object.entries(rolesByLoc).map(([lid, role]) => [lid, { role, permissions: perms[lid] || {} }]),
    ),
    roleTemplatesByLocation: {},
  }
}

const claimant = () => member(CLAIMANT_ID, { [LOC_A]: 'staff' })
// Manager at A with the expense-approval permission granted — not an owner.
const approverAtA = () => member('22222222-2222-2222-2222-222222222222', { [LOC_A]: 'manager' }, { [LOC_A]: { approvals_fte_expenses: true } })
const ownerAtA = () => member('33333333-3333-3333-3333-333333333333', { [LOC_A]: 'owner' })
// Owner (full approval rights) — but at a DIFFERENT studio.
const ownerAtB = () => member('44444444-4444-4444-4444-444444444444', { [LOC_B]: 'owner' })
// Plain staff at the claim's own studio — not the claimant.
const colleagueAtA = () => member('55555555-5555-5555-5555-555555555555', { [LOC_A]: 'staff' })

function claimRow(status = 'submitted') {
  return {
    id: CLAIM_ID, profile_id: CLAIMANT_ID, location_id: LOC_A, status,
    period_start: '2026-09-01', period_end: '2026-09-30',
    total_amount: 10, total_vat_amount: 0, item_count: 1, notes: null,
    profile: { id: CLAIMANT_ID, full_name: 'Fiona FTE', email: 'fiona@example.test' },
    location: { id: LOC_A, name: 'Studio A' },
    items: [],
  }
}

beforeEach(() => {
  h.user = null
  h.claim = claimRow()
  h.updated = []
})

async function answer(res) {
  return { status: res.status, body: await res.json() }
}

// Every route, called as `who`, against a claim that exists vs one that doesn't.
const ROUTES = {
  'GET detail': () => GET({}, ctx),
  'PATCH detail': () => PATCH(jsonReq({ notes: 'x' }), ctx),
  'DELETE detail': () => DELETE({}, ctx),
  approve: () => APPROVE(jsonReq(), ctx),
  decline: () => DECLINE(jsonReq({ reason: 'no' }), ctx),
  submit: () => SUBMIT(jsonReq(), ctx),
  revoke: () => REVOKE(jsonReq(), ctx),
  'add item': () => ADD_ITEM(jsonReq({}), ctx),
  'upload-sign': () => UPLOAD_SIGN(jsonReq({ filename: 'a.jpg', content_type: 'image/jpeg', size: 10 }), ctx),
  'PATCH item': () => PATCH_ITEM(jsonReq({ vendor: 'x' }), itemCtx),
  'DELETE item': () => DELETE_ITEM({}, itemCtx),
  receipt: () => RECEIPT({}, itemCtx),
}

describe('FINALTIDY.1 — a caller who cannot see a claim gets the missing-claim 404', () => {
  for (const [name, call] of Object.entries(ROUTES)) {
    for (const [label, who] of [['owner at another studio', ownerAtB], ['staff colleague at the same studio', colleagueAtA]]) {
      it(`${name}: ${label} → 404 identical to a missing claim`, async () => {
        h.user = who()
        h.claim = null
        const missing = await answer(await call())
        h.claim = claimRow()
        const hidden = await answer(await call())
        expect(missing.status).toBe(404)
        expect(hidden).toEqual(missing)
        expect(h.updated).toEqual([])
      })
    }
  }
})

describe('GET /api/expenses/[id] — who can see it', () => {
  it('the claimant → 200, viewer_role self', async () => {
    h.user = claimant()
    const { status, body } = await answer(await GET({}, ctx))
    expect(status).toBe(200)
    expect(body.data.viewer_role).toBe('self')
  })

  it('an expense approver at the studio → 200, viewer_role approver', async () => {
    h.user = approverAtA()
    const { status, body } = await answer(await GET({}, ctx))
    expect(status).toBe(200)
    expect(body.data.viewer_role).toBe('approver')
  })

  it('an owner at the studio → 200, viewer_role owner', async () => {
    h.user = ownerAtA()
    const { status, body } = await answer(await GET({}, ctx))
    expect(status).toBe(200)
    expect(body.data.viewer_role).toBe('owner')
  })

  it('a master anywhere → 200', async () => {
    h.user = { ...ownerAtB(), role: 'master', profileRole: 'master' }
    const { status, body } = await answer(await GET({}, ctx))
    expect(status).toBe(200)
    expect(body.data.viewer_role).toBe('master')
  })
})

describe('approve / decline — see-but-cannot-act keeps an honest 403', () => {
  it('the approver at the studio approves → 200', async () => {
    h.user = approverAtA()
    const { status, body } = await answer(await APPROVE(jsonReq(), ctx))
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(h.updated.some((u) => u.table === 'fte_expense_claims' && u.patch.status === 'awaiting_accountant_review')).toBe(true)
  })

  it('the claimant, who can see their own claim, gets 403 on approve and decline', async () => {
    h.user = claimant()
    expect((await APPROVE(jsonReq(), ctx)).status).toBe(403)
    expect((await DECLINE(jsonReq({ reason: 'no' }), ctx)).status).toBe(403)
    expect(h.updated).toEqual([])
  })

  it('an owner whose expense approval was switched off can still see it, so 403 not 404', async () => {
    h.user = member('33333333-3333-3333-3333-333333333333', { [LOC_A]: 'owner' }, { [LOC_A]: { approvals_fte_expenses: false } })
    expect((await GET({}, ctx)).status).toBe(200)
    expect((await APPROVE(jsonReq(), ctx)).status).toBe(403)
  })
})

describe('submitter-only actions', () => {
  it('the claimant submits their own draft → 200', async () => {
    h.user = claimant()
    h.claim = claimRow('draft')
    const { status } = await answer(await SUBMIT(jsonReq(), ctx))
    expect(status).toBe(200)
  })

  it('an approver who can see the claim gets the existing 403 on submit', async () => {
    h.user = approverAtA()
    h.claim = claimRow('draft')
    expect((await SUBMIT(jsonReq(), ctx)).status).toBe(403)
  })

  it('the claimant reads their own receipt → 200', async () => {
    h.user = claimant()
    const { status, body } = await answer(await RECEIPT({}, itemCtx))
    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })
})
