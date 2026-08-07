// EMAIL-OUTBOUND-ATTACH.1 — throwing away a draft the operator removed.
//
// This is a DELETE primitive reachable from the browser, so the property that
// matters is that it cannot be steered: the key is rebuilt from the session's
// own profile id, which is why the route needs no ticket and no mailbox and
// still cannot touch anything that is not the caller's own draft.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { EMAIL_ATTACHMENT_BUCKET } from '@/lib/email-attachment-quota'
import { outboundDraftPath } from '@/lib/email-outbound-attachments'
import { makeDb, objectKeys, seedObject, writesTo } from '../../tickets/_test-db'
import { COACH, baseState } from '../../tickets/_test-fixtures'

const DRAFT = '22222222-2222-4222-8222-222222222222'
const REF = { draft_id: DRAFT, index: 0, filename: 'invoice.pdf', mime: 'application/pdf' }

function post(body) {
  return POST(new Request('http://x/api/email/attachments/discard', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  getCurrentUser.mockResolvedValue(COACH)
  db = makeDb(baseState({}))
  createServerClient.mockImplementation(() => db)
})

function seedFor(profileId, index = 0) {
  const path = outboundDraftPath({ profileId, draftId: DRAFT, index, mime: 'application/pdf' })
  seedObject(db, EMAIL_ATTACHMENT_BUCKET, path, 'bytes')
  return `${EMAIL_ATTACHMENT_BUCKET}/${path}`
}

describe('POST /api/email/attachments/discard', () => {
  it('401s when unauthenticated, and removes nothing', async () => {
    const mine = seedFor(COACH.id)
    getCurrentUser.mockResolvedValue(null)
    expect((await post(REF)).status).toBe(401)
    expect(objectKeys(db)).toContain(mine)
  })

  it('removes the caller’s own draft', async () => {
    const mine = seedFor(COACH.id)
    const res = await post(REF)
    expect(res.status).toBe(200)
    expect(objectKeys(db)).not.toContain(mine)
  })

  it('CANNOT reach another person’s draft, even with their exact draft id', async () => {
    const theirs = seedFor('profile-someone-else')
    const res = await post(REF)
    expect(res.status).toBe(200)
    // The key was rebuilt under the CALLER'S prefix, so nothing of theirs was
    // addressed at all — there is no id here that could name it.
    expect(objectKeys(db)).toContain(theirs)
  })

  it('is a 200 even when there was nothing there — nothing to enumerate', async () => {
    const res = await post({ ...REF, index: 3 })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })

  it('400s on a malformed reference rather than removing something else', async () => {
    const mine = seedFor(COACH.id)
    expect((await post({ ...REF, draft_id: '../..' })).status).toBe(400)
    expect((await post({ ...REF, index: -1 })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect(objectKeys(db)).toContain(mine)
  })

  it('writes nothing to the database and moves no counter', async () => {
    seedFor(COACH.id)
    await post(REF)
    expect(writesTo(db)).toEqual([])
    expect(db.rpcs).toEqual([])
  })

  it('still answers 200 when Storage refuses the removal', async () => {
    db = makeDb(baseState({ storageErrors: { remove: { message: 'nope' } } }))
    createServerClient.mockImplementation(() => db)
    seedFor(COACH.id)
    // The chip is already gone from the composer; a storage failure is a cost
    // line, not something the operator can act on.
    expect((await post(REF)).status).toBe(200)
  })
})
