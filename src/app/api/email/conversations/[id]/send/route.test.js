// INBOX-PERM.2 — POST /api/email/conversations/[id]/send (legacy reply).
//
// The worst of the three. This route puts real mail on the wire from the
// company address, and until INBOX-PERM.2 it asked whether the caller held the
// WHATSAPP permission before doing so. The assertion that matters is not the
// status code — it is that sendEmail is never reached.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/postmark', () => ({ sendEmail: vi.fn() }))

import { POST } from './route'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { sendEmail } from '@/lib/postmark'
import { makeDb, insertsInto } from '../../../tickets/_test-db'
import { WA_ONLY, EMAIL_ONLY, CONV, baseState } from '../../_test-fixtures'

function post(body, id = CONV.id) {
  return POST(
    new Request(`http://x/api/email/conversations/${id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  db = makeDb(baseState())
  createServerClient.mockImplementation(() => db)
  getCurrentUser.mockResolvedValue(EMAIL_ONLY)
  sendEmail.mockResolvedValue({ messageId: 'pm-1' })
})

describe('POST /api/email/conversations/[id]/send', () => {
  it('401s when unauthenticated — and sends nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ text: 'hello' })).status).toBe(401)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('403s a user holding `whatsapp` but NOT `email_inbox` — AND NEVER SENDS', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    const res = await post({ text: 'hello from a coach' })
    expect(res.status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(0)
  })

  it('allows a user holding `email_inbox` to send', async () => {
    const res = await post({ text: 'Six sharp.' })
    expect(res.status).toBe(200)
    expect(sendEmail).toHaveBeenCalledTimes(1)
    expect(sendEmail.mock.calls[0][0].to).toBe(CONV.counterpart_email)
    expect(insertsInto(db, 'email_inbox_messages')).toHaveLength(1)
  })
})
