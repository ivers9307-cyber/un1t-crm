// POST /api/sequences/[id]/enrollments/[enrollmentId]/resume through the real
// withAuth wrapper: signed in (401, now 'Unauthorized'), email somewhere (403,
// the old text), the sequence (404), its studio (404, never 403), email there
// (403), then the compare-and-set resume.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../../tests/helpers/fake-db.js'
import { person, LOC_A, LOC_B } from '../../../../../../../../tests/helpers/role-sweep-callers.js'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

const { getCurrentUser } = await import('@/lib/auth')
const { createServerClient } = await import('@/lib/supabase')
const { POST } = await import('./route.js')

const SEQ_A = '5e000000-0000-4000-8000-00000000000a'
const SEQ_B = '5e000000-0000-4000-8000-00000000000b'
const ENR_A = 'e0000000-0000-4000-8000-00000000000a'
const ENR_B = 'e0000000-0000-4000-8000-00000000000b'
const EMAIL_A = person({ [LOC_A]: { role: 'manager', permissions: { email: true } } }, LOC_A)
const NO_EMAIL = person({ [LOC_A]: { role: 'manager', permissions: { email: false } } }, LOC_A)
const resume = (id, enrollmentId) => POST(new Request(`http://localhost/api/sequences/${id}/enrollments/${enrollmentId}/resume`, { method: 'POST' }), { params: Promise.resolve({ id, enrollmentId }) })
let db

beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: {
    email_sequences: [{ id: SEQ_A, location_id: LOC_A }, { id: SEQ_B, location_id: LOC_B }],
    sequence_enrollments: [
      { id: ENR_A, sequence_id: SEQ_A, status: 'paused', next_step_at: null },
      { id: ENR_B, sequence_id: SEQ_B, status: 'paused', next_step_at: null },
    ],
  } })
  createServerClient.mockReturnValue(db)
})

describe('POST …/enrollments/[enrollmentId]/resume', () => {
  it('401 signed out, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await resume(SEQ_A, ENR_A)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(db.tables.sequence_enrollments[0].status).toBe('paused')
  })

  it('403 without email anywhere, the old text', async () => {
    getCurrentUser.mockResolvedValue(NO_EMAIL)
    const res = await resume(SEQ_A, ENR_A)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Email permission required' })
  })

  it('404 for another studio’s sequence, nothing changed', async () => {
    getCurrentUser.mockResolvedValue(EMAIL_A)
    expect((await resume(SEQ_B, ENR_B)).status).toBe(404)
    expect(db.tables.sequence_enrollments[1].status).toBe('paused')
  })

  it('resumes the caller’s own paused enrolment', async () => {
    getCurrentUser.mockResolvedValue(EMAIL_A)
    const res = await resume(SEQ_A, ENR_A)
    expect(res.status).toBe(200)
    expect(db.tables.sequence_enrollments[0].status).toBe('active')
  })

  it('a failed write answers a fixed 500, never the database text', async () => {
    getCurrentUser.mockResolvedValue(EMAIL_A)
    db.errors.sequence_enrollments = { update: { code: '40001', message: 'could not serialize access due to concurrent update' } }
    const res = await resume(SEQ_A, ENR_A)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ success: false, error: 'Could not resume the enrolment. Try again.' })
  })
})
