// SEQGAPS.1 Task B — POST /api/sequences/[id]/enrollments/[enrollmentId]/exit
//
// The guard idiom is the resume route's, so the tests are too: session auth,
// email permission, location scope on the PARENT sequence (service-role
// routes get no RLS — nothing else filters this), uuidLike on the id, 404
// for a missing/foreign enrolment.
//
// The property worth the most here is the compare-and-set. makeFakeDb is
// filter-aware, so the second POST really re-reads the row it just mutated:
// a blind `.update()` would return the row twice and pass, this fails it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeDb } from '@/lib/api-auth.test-helpers.js'

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))
vi.mock('@/lib/auth', async (importActual) => {
  const actual = await importActual()
  return { ...actual, getCurrentUser: vi.fn(async () => null) }
})
vi.mock('@/lib/permissions', async (importActual) => {
  const actual = await importActual()
  return { ...actual, hasPermission: vi.fn(() => true) }
})

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

const SEQ = '11111111-1111-1111-1111-111111111111'
const ENR = '22222222-2222-2222-2222-222222222222'
const OTHER_SEQ = '33333333-3333-3333-3333-333333333333'

const props = (id = SEQ, enrollmentId = ENR) => ({ params: Promise.resolve({ id, enrollmentId }) })
const req = () => new Request('http://localhost/api/sequences/x/enrollments/y/exit', { method: 'POST' })

const managerAt = (...locationIds) => ({
  role: 'manager',
  isMaster: false,
  locations: locationIds.map((id) => ({ id, organization_id: 'org-1' })),
})

let tables
beforeEach(() => {
  hasPermission.mockReturnValue(true)
  tables = {
    email_sequences: [
      { id: SEQ, location_id: 'loc-1' },
      { id: OTHER_SEQ, location_id: 'loc-2' },
    ],
    sequence_enrollments: [
      {
        id: ENR,
        sequence_id: SEQ,
        contact_id: 'c1',
        status: 'active',
        exit_reason: null,
        next_step_at: '2026-08-10T09:00:00.000Z',
        last_processed_at: null,
      },
    ],
  }
  db = makeFakeDb(tables)
  getCurrentUser.mockResolvedValue(managerAt('loc-1'))
})

describe('guards', () => {
  it('401 with no session', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await POST(req(), props())).status).toBe(401)
  })

  it('403 without the email permission', async () => {
    hasPermission.mockReturnValue(false)
    expect((await POST(req(), props())).status).toBe(403)
  })

  it('404 — not 400 — for a non-uuid enrollment id', async () => {
    const res = await POST(req(), props(SEQ, 'not-a-uuid'))
    expect(res.status).toBe(404)
  })

  it('404 when the sequence does not exist', async () => {
    const res = await POST(req(), props('44444444-4444-4444-4444-444444444444'))
    expect(res.status).toBe(404)
  })

  it('403 when the sequence belongs to a location the caller cannot see', async () => {
    const res = await POST(req(), props(OTHER_SEQ))
    expect(res.status).toBe(403)
    expect(tables.sequence_enrollments[0].status).toBe('active')
  })

  it('404 when the enrolment belongs to a DIFFERENT sequence (no cross-sequence exit)', async () => {
    tables.sequence_enrollments[0].sequence_id = OTHER_SEQ
    const res = await POST(req(), props())
    expect(res.status).toBe(404)
    expect(tables.sequence_enrollments[0].status).toBe('active')
  })
})

describe('the exit itself', () => {
  it('exits an active enrolment with exit_reason=manual_exit and unschedules it', async () => {
    const res = await POST(req(), props())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    const row = tables.sequence_enrollments[0]
    expect(row.status).toBe('exited')
    expect(row.exit_reason).toBe('manual_exit')
    expect(row.next_step_at).toBeNull()
    expect(row.last_processed_at).toBeTruthy()
  })

  it('exits a PAUSED enrolment too (the operator gave up on the errored one)', async () => {
    tables.sequence_enrollments[0].status = 'paused'
    expect((await POST(req(), props())).status).toBe(200)
    expect(tables.sequence_enrollments[0].status).toBe('exited')
  })
})

describe('compare-and-set (409, not a blind update)', () => {
  it('the SECOND click 409s instead of re-writing the row', async () => {
    const first = await POST(req(), props())
    expect(first.status).toBe(200)
    const stampedAt = tables.sequence_enrollments[0].last_processed_at

    const second = await POST(req(), props())
    expect(second.status).toBe(409)
    const body = await second.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/already left this sequence/i)
    // A blind update would have restamped it.
    expect(tables.sequence_enrollments[0].last_processed_at).toBe(stampedAt)
  })

  it('409 when the scheduler completed the enrolment first (cron race)', async () => {
    tables.sequence_enrollments[0].status = 'completed'
    const res = await POST(req(), props())
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/completed/)
    expect(tables.sequence_enrollments[0].exit_reason).toBeNull()
  })
})
