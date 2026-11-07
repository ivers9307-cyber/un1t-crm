// PIPEBUILD.5g — follow-up sequences are hidden from Automations and locked to
// their board in the HTTP routes ONLY. The library path (publishSequence) must
// keep working for the board's own install, approval and replace.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: (user, locationId) => {
    const allowed = (user?.locations || []).some((l) => l.id === locationId)
    return allowed ? null : new Response(JSON.stringify({ success: false, error: 'Not found' }), { status: 404 })
  },
}))
vi.mock('@/lib/sequence-access', () => ({
  canBuildSequencesAt: () => true,
  canBuildSequencesSomewhere: () => true,
  canCloneSequenceAt: () => true,
  sequencePermissionRequired: () => new Response('{}', { status: 403 }),
  sequenceNotFound: () => new Response('{}', { status: 404 }),
}))
vi.mock('@/lib/permissions', () => ({
  hasPermissionAtAnyLocation: () => true,
  hasPermissionForLocation: () => true,
  hasPermission: () => true,
}))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import {
  followupOwnedSequenceIds, refuseIfFollowupOwned, isRetiredFollowupSequence, archiveSupersededSequence,
  RETIRED_FOLLOWUP_MESSAGE,
} from './followup-owned-sequences'
import { logError } from '@/lib/log'
import { publishSequence } from '@/lib/sequences/publish'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { PUT as PATCH_SEQ } from '@/app/api/sequences/[id]/route'
import { PUT as PUT_GRAPH } from '@/app/api/sequences/[id]/graph/route'
import { PUT as PUT_STEPS } from '@/app/api/sequences/[id]/steps/route'
import { POST as PUBLISH } from '@/app/api/sequences/[id]/graph/publish/route'
import { POST as ENROL } from '@/app/api/sequences/[id]/enrol/route'
import { POST as CLONE } from '@/app/api/sequences/[id]/clone/route'

const SEQ = 'a0000000-0000-4000-8000-000000000001'
const LOC = 'c0000000-0000-4000-8000-000000000003'
const USER = { id: 'u1', role: 'owner', locations: [{ id: LOC, role: 'owner' }] }
const props = { params: Promise.resolve({ id: SEQ }) }
const req = (body = {}) => new Request('http://x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

// db: email_sequences (single row), pipeline_stage_followups (owned list or error)
function fakeDb({ owned = true, ownershipError = null, row: rowOver = {} } = {}) {
  const followupTouched = vi.fn()
  const writes = vi.fn()
  const row = { id: SEQ, location_id: LOC, status: 'active', graph: null, draft_graph: null, name: 'Follow up', trigger_type: 'manual', trigger_config: {}, sequence_steps: [], ...rowOver }
  const db = {
    followupTouched, writes,
    from: vi.fn((table) => {
      if (table === 'pipeline_stage_followups') {
        followupTouched()
        const q = {
          select: () => q, eq: () => q, not: () => q, order: () => q, range: () => q, limit: () => q,
          then: (res, rej) => Promise.resolve({
            data: ownershipError ? null : (owned ? [{ id: 'f1', sequence_id: SEQ }] : []),
            error: ownershipError,
          }).then(res, rej),
        }
        return q
      }
      if (table === 'email_sequences') {
        const q = {
          select: () => q, eq: () => q,
          single: async () => ({ data: row, error: null }),
          maybeSingle: async () => ({ data: row, error: null }),
          insert: (r) => { writes(r); return { select: () => ({ single: async () => ({ data: { id: 'new', name: 'Copy' }, error: null }) }) } },
          update: (u) => { writes(u); const c = { eq: () => c, select: () => c, single: async () => ({ data: row, error: null }), then: (res) => Promise.resolve({ error: null }).then(res) }; return c },
        }
        return q
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
  return db
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(USER)
})

describe('followupOwnedSequenceIds', () => {
  it('collectsIdsAcrossPages', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `f${i}`, sequence_id: `s${i}` }))
    const page2 = [{ id: 'fz', sequence_id: 'sz' }]
    const ranges = []
    const db = {
      from: () => {
        const q = {
          select: () => q, eq: () => q, not: () => q, order: () => q,
          range: (a, b) => { ranges.push([a, b]); return Promise.resolve({ data: a === 0 ? page1 : page2, error: null }) },
        }
        return q
      },
    }
    const r = await followupOwnedSequenceIds(db, LOC)
    expect(r.ok).toBe(true)
    expect(r.ids.size).toBe(1001)
    expect(ranges).toEqual([[0, 999], [1000, 1999]])
  })

  it('failedReadIsNotOk', async () => {
    const r = await followupOwnedSequenceIds(fakeDb({ ownershipError: { message: 'boom' } }), LOC)
    expect(r.ok).toBe(false)
  })
})

describe('refuseIfFollowupOwned', () => {
  it('ownedIs409WithCode', async () => {
    const res = await refuseIfFollowupOwned(fakeDb(), { id: SEQ, location_id: LOC })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      success: false,
      error: 'This follow-up belongs to a pipeline board. Change it in Settings → Pipelines.',
      code: 'followup_owned',
    })
  })

  it('notOwnedIsNull', async () => {
    expect(await refuseIfFollowupOwned(fakeDb({ owned: false }), { id: SEQ, location_id: LOC })).toBeNull()
  })

  it('ownershipReadFailureIs503', async () => {
    const res = await refuseIfFollowupOwned(fakeDb({ ownershipError: { message: 'boom' } }), { id: SEQ, location_id: LOC })
    expect(res.status).toBe(503)
  })
})

describe('routes refuse a follow-up-owned sequence before any write', () => {
  const cases = [
    ['patchFollowupSequenceIs409', PATCH_SEQ, { name: 'x' }],
    ['graphFollowupSequenceIs409', PUT_GRAPH, { graph: { version: 1, nodes: [], edges: [] } }],
    ['stepsFollowupSequenceIs409', PUT_STEPS, { steps: [{ id: 'd0000000-0000-4000-8000-000000000004', step_order: 1 }] }],
    ['publishFollowupSequenceIs409', PUBLISH, {}],
    ['enrolFollowupSequenceIs409', ENROL, { contact_ids: ['b0000000-0000-4000-8000-000000000009'] }],
  ]
  for (const [name, handler, body] of cases) {
    it(name, async () => {
      const db = fakeDb()
      createServerClient.mockReturnValue(db)
      const res = await handler(req(body), props)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('followup_owned')
      expect(db.writes).not.toHaveBeenCalled()
    })
  }

  it('ownershipReadFailureOnRouteIs503', async () => {
    const db = fakeDb({ ownershipError: { message: 'boom' } })
    createServerClient.mockReturnValue(db)
    const res = await PATCH_SEQ(req({ name: 'x' }), props)
    expect(res.status).toBe(503)
    expect(db.writes).not.toHaveBeenCalled()
  })

  it('cloneOfFollowupSequenceAllowed', async () => {
    const db = fakeDb()
    createServerClient.mockReturnValue(db)
    const res = await CLONE(req(), props)
    expect(res.status).toBe(200)
    expect(db.followupTouched).not.toHaveBeenCalled()
  })
})

// PIPEBUILD.5l — a superseded follow-up sequence (archived by the board when
// its row moved on, or its stage was removed) is no longer owned, so the
// ownership guard lets it through; the retired rule must still refuse it.
const retired = { status: 'archived', trigger_type: 'pipeline_stage_change', trigger_config: { to_status: 'o_reset_new' } }

describe('isRetiredFollowupSequence', () => {
  it('onlyAnArchivedStageChangeOnAnOfferStage', () => {
    expect(isRetiredFollowupSequence(retired)).toBe(true)
    expect(isRetiredFollowupSequence({ ...retired, status: 'paused' })).toBe(false)
    expect(isRetiredFollowupSequence({ ...retired, trigger_type: 'manual' })).toBe(false)
    expect(isRetiredFollowupSequence({ ...retired, trigger_config: { to_status: 'new_lead' } })).toBe(false)
    expect(isRetiredFollowupSequence({ ...retired, trigger_config: null })).toBe(false)
    expect(isRetiredFollowupSequence(null)).toBe(false)
  })
})

describe('routes refuse to bring back a retired follow-up sequence', () => {
  for (const [name, body] of [
    ['putActiveOnARetiredSequenceIs409', { status: 'active' }],
    ['putDraftOnARetiredSequenceIs409', { status: 'draft' }],
    ['putPausedOnARetiredSequenceIs409', { status: 'paused' }],
    ['putATriggerEditOnARetiredSequenceIs409', { trigger_type: 'manual' }],
  ]) {
    it(name, async () => {
      const db = fakeDb({ owned: false, row: retired })
      createServerClient.mockReturnValue(db)
      const res = await PATCH_SEQ(req(body), props)
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ success: false, error: RETIRED_FOLLOWUP_MESSAGE, code: 'followup_retired' })
      expect(db.writes).not.toHaveBeenCalled()
    })
  }

  it('publishOfARetiredSequenceIs409', async () => {
    const db = fakeDb({ owned: false, row: retired })
    createServerClient.mockReturnValue(db)
    const res = await PUBLISH(req({}), props)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('followup_retired')
    expect(db.writes).not.toHaveBeenCalled()
  })

  it('aRenameOfARetiredSequenceIsStillAllowed', async () => {
    const db = fakeDb({ owned: false, row: retired })
    createServerClient.mockReturnValue(db)
    const res = await PATCH_SEQ(req({ name: 'Old follow-up' }), props)
    expect(res.status).toBe(200)
    expect(db.writes).toHaveBeenCalledWith({ name: 'Old follow-up' })
  })

  it('anOrdinaryArchivedSequenceCanStillBeUnarchived', async () => {
    const db = fakeDb({ owned: false, row: { status: 'archived', trigger_type: 'manual', trigger_config: {} } })
    createServerClient.mockReturnValue(db)
    const res = await PATCH_SEQ(req({ status: 'draft' }), props)
    expect(res.status).toBe(200)
    expect(db.writes).toHaveBeenCalledWith({ status: 'draft' })
  })
})

describe('archiveSupersededSequence', () => {
  const recorder = (answer) => {
    const seen = {}
    const q = {
      update: (v) => { seen.values = v; return q },
      eq: (c, v) => { (seen.eq ||= {})[c] = v; return q },
      in: (c, v) => { seen.in = [c, v]; return q },
      select: (c) => { seen.select = c; return q },
      then: (res, rej) => Promise.resolve(answer).then(res, rej),
    }
    return { seen, db: { from: (t) => { seen.table = t; return q } } }
  }

  it('archivesOnlyAPausedOrDraftSequenceAtTheStudio', async () => {
    const { seen, db } = recorder({ data: [{ id: 's1' }], error: null })
    expect(await archiveSupersededSequence(db, LOC, 's1')).toEqual({ ok: true, archived: 1 })
    expect(seen.table).toBe('email_sequences')
    expect(seen.values).toMatchObject({ status: 'archived', updated_at: expect.any(String) })
    expect(seen.eq).toEqual({ id: 's1', location_id: LOC })
    expect(seen.in).toEqual(['status', ['paused', 'draft']])
    expect(seen.select).toBe('id')
  })

  it('aFailedWriteIsLoggedNotThrown', async () => {
    const { db } = recorder({ data: null, error: { message: 'boom' } })
    expect(await archiveSupersededSequence(db, LOC, 's1', { followupId: 'f1' })).toEqual({ ok: false, archived: 0 })
    expect(logError).toHaveBeenCalledWith('followup-owned-sequences', 'superseded follow-up sequence not archived', expect.objectContaining({ sequenceId: 's1', followupId: 'f1' }))
  })

  it('noSequenceIsANoOp', async () => {
    expect(await archiveSupersededSequence({ from: () => { throw new Error('no read') } }, LOC, null)).toEqual({ ok: true, archived: 0 })
  })
})

describe('the library is not guarded', () => {
  it('publishSequenceStillPublishesAFollowupOwnedSequence', async () => {
    const graph = { version: 1, trigger: { type: 'manual', config: {} }, nodes: [{ id: 'n1', type: 'email', config: { subject: 'hi' } }], edges: [{ from: 'trigger', to: 'n1' }] }
    const followupTouched = vi.fn()
    const db = {
      rpc: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      from: vi.fn((table) => {
        if (table === 'pipeline_stage_followups') { followupTouched(); throw new Error('the library must not read follow-ups') }
        if (table === 'email_sequences') {
          return {
            select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { location_id: LOC, graph: null, draft_graph: graph }, error: null })) })) })),
            update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })),
          }
        }
        if (table === 'sequence_steps') return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [], error: null })) })) }
        throw new Error(`unexpected table ${table}`)
      }),
    }
    const r = await publishSequence(db, { sequenceId: SEQ })
    expect(r.ok).toBe(true)
    expect(followupTouched).not.toHaveBeenCalled()
  })
})
