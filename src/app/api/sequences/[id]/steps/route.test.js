// PIPEBUILD.2f — the legacy steps API closes the back door PR 1 left open.
//
// PR 1 made publishing/activating a sequence refuse an unapproved WhatsApp
// template, but POST/PUT on /api/sequences/[id]/steps (and the single-step PUT)
// could still point a LIVE sequence's step at a PENDING or REJECTED template.
// A draft is never checked; a read failure is a 503; a failed bulk update is a
// 500 naming the step (it used to be ignored).

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    if (!user) return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), { status: 401 })
    const allowed = (user.locations || []).some((l) => l.id === locationId)
    if (!allowed) return new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
    return null
  },
}))
vi.mock('@/lib/sequence-access', () => ({
  canBuildSequencesAt: () => true,
  canBuildSequencesSomewhere: () => true,
  sequencePermissionRequired: () => new Response('{}', { status: 403 }),
  sequenceNotFound: () => new Response('{}', { status: 404 }),
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { POST, PUT } from './route.js'
import { PUT as PUT_ONE } from './[stepId]/route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

const SEQ_ID = 'a0000000-0000-4000-8000-000000000001'
const LOC_ID = 'c0000000-0000-4000-8000-000000000003'
const STEP_ID = 'd0000000-0000-4000-8000-000000000004'
const TPL_ID = 'e0000000-0000-4000-8000-000000000005'
const OWNER = { id: 'u1', role: 'owner', locations: [{ id: LOC_ID, role: 'owner' }] }

function mockDb({ status = 'active', templates = [], templateError = null, updateError = null } = {}) {
  const calls = { insert: vi.fn(), update: vi.fn(), templateRead: vi.fn() }
  const db = {
    from: vi.fn((table) => {
      if (table === 'email_sequences') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { location_id: LOC_ID, status }, error: null })) })) })) }
      }
      if (table === 'whatsapp_templates') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ in: vi.fn(() => { calls.templateRead(); return Promise.resolve({ data: templateError ? null : templates, error: templateError }) }) })) })) }
      }
      if (table === 'sequence_steps') {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ order: vi.fn(() => ({ limit: vi.fn(async () => ({ data: [], error: null })) })) })) })),
          insert: vi.fn((row) => { calls.insert(row); return { select: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: STEP_ID, ...row }, error: null })) })) } }),
          update: vi.fn((u) => {
            calls.update(u)
            const result = { data: { id: STEP_ID, ...u }, error: updateError }
            const chain = { eq: vi.fn(() => chain), select: vi.fn(() => chain), single: vi.fn(async () => result), then: (res, rej) => Promise.resolve(result).then(res, rej) }
            return chain
          }),
        }
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return { db, calls }
}

const json = (method, body) => new Request('http://localhost/api/x', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = (p = {}) => ({ params: Promise.resolve({ id: SEQ_ID, ...p }) })
const PENDING = [{ id: TPL_ID, name: 'Welcome', status: 'PENDING', components: [] }]
const APPROVED = [{ id: TPL_ID, name: 'Welcome', status: 'APPROVED', components: [] }]
const COPY = 'Step 3 uses the WhatsApp template "Welcome", which is PENDING at Meta. Use it once the template is approved.'
const waStep = { step_type: 'whatsapp', whatsapp_template_id: TPL_ID, step_order: 3 }

beforeEach(() => { vi.clearAllMocks(); getCurrentUser.mockResolvedValue(OWNER) })

describe('legacy steps API: live sequence + unapproved template', () => {
  it('liveSequencePendingTemplateRefused - POST', async () => {
    const { db, calls } = mockDb({ templates: PENDING })
    createServerClient.mockReturnValue(db)
    const res = await POST(json('POST', waStep), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(COPY)
    expect(calls.insert).not.toHaveBeenCalled()
  })

  it('liveSequencePendingTemplateRefused - PUT (bulk)', async () => {
    const { db, calls } = mockDb({ templates: PENDING })
    createServerClient.mockReturnValue(db)
    const res = await PUT(json('PUT', { steps: [{ id: STEP_ID, step_order: 3, whatsapp_template_id: TPL_ID }] }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(COPY)
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('liveSequencePendingTemplateRefused - PUT (single step)', async () => {
    const { db, calls } = mockDb({ templates: PENDING })
    createServerClient.mockReturnValue(db)
    const res = await PUT_ONE(json('PUT', { step_order: 3, whatsapp_template_id: TPL_ID }), params({ stepId: STEP_ID }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(COPY)
    expect(calls.update).not.toHaveBeenCalled()
  })

  it('an approved template on a live sequence is accepted', async () => {
    const { db, calls } = mockDb({ templates: APPROVED })
    createServerClient.mockReturnValue(db)
    const res = await POST(json('POST', waStep), params())
    expect(res.status).toBe(200)
    expect(calls.insert).toHaveBeenCalledTimes(1)
  })

  it('draftSequenceNotChecked', async () => {
    const { db, calls } = mockDb({ status: 'draft', templates: PENDING })
    createServerClient.mockReturnValue(db)
    expect((await POST(json('POST', waStep), params())).status).toBe(200)
    expect((await PUT(json('PUT', { steps: [{ id: STEP_ID, whatsapp_template_id: TPL_ID }] }), params())).status).toBe(200)
    expect((await PUT_ONE(json('PUT', { whatsapp_template_id: TPL_ID }), params({ stepId: STEP_ID }))).status).toBe(200)
    expect(calls.templateRead).not.toHaveBeenCalled()
  })

  it('a live sequence is not checked when no template is set', async () => {
    const { db, calls } = mockDb({ templates: PENDING })
    createServerClient.mockReturnValue(db)
    const res = await PUT(json('PUT', { steps: [{ id: STEP_ID, step_order: 1, whatsapp_template_id: null }] }), params())
    expect(res.status).toBe(200)
    expect(calls.templateRead).not.toHaveBeenCalled()
  })

  it('readFailure503', async () => {
    const { db, calls } = mockDb({ templateError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await POST(json('POST', waStep), params())
    expect(res.status).toBe(503)
    expect(calls.insert).not.toHaveBeenCalled()
  })
})

describe('legacy steps API: bulk PUT write errors', () => {
  it('putUpdateErrorReported', async () => {
    const { db } = mockDb({ status: 'draft', updateError: { message: 'constraint violated' } })
    createServerClient.mockReturnValue(db)
    const res = await PUT(json('PUT', { steps: [{ id: STEP_ID, step_order: 7, delay_days: 2 }] }), params())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('step 7')
  })
})
