// EMAIL-CONV-STOP.1 — POST /api/email/conversations/[id]/send is RETIRED.
//
// The most consequential of the three: it put real mail on the wire from the
// company address. It now answers 410 Gone, and the assertion that matters is
// not the status code — it is that sendEmail is NEVER reached and no database
// client is ever created. Replies live at POST /api/email/tickets/[id]/reply,
// which also carries the per-mailbox email_mailbox_access grant this route
// never had.

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
import { WA_ONLY, EMAIL_ONLY, CONV_ID } from '../../_test-fixtures'

function post(body, id = CONV_ID) {
  return POST(
    new Request(`http://x/api/email/conversations/${id}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(EMAIL_ONLY)
  sendEmail.mockResolvedValue({ messageId: 'pm-1' })
})

describe('POST /api/email/conversations/[id]/send — retired', () => {
  it('401s when unauthenticated — and sends nothing', async () => {
    getCurrentUser.mockResolvedValue(null)
    expect((await post({ text: 'hello' })).status).toBe(401)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('403s a user holding `whatsapp` but NOT `email_inbox` — AND NEVER SENDS', async () => {
    getCurrentUser.mockResolvedValue(WA_ONLY)
    expect((await post({ text: 'hello from a coach' })).status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('410s the permitted caller, sends nothing and reads nothing', async () => {
    const res = await post({ text: 'Six sharp.' })
    expect(res.status).toBe(410)
    const body = await res.json()
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/retired/i)
    expect(body.error).toMatch(/ticket/i)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(createServerClient).not.toHaveBeenCalled()
  })
})
