// WATPLSEND.1 (review) — the WhatsApp send route answers SUCCESS with
// `warnings` when Meta accepted the message but the thread row or the
// conversation update failed. The phone used to drop them, so a message
// missing from the thread looked unsent and staff sent it again: the customer
// got it twice. The decision lives here (no RN component test runner); the
// thread screen is pinned below to call it on both of its sends.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sendWarningsNotice } from './wa-send-warnings'

describe('sendWarningsNotice', () => {
  it('is null for a clean send, a failed send, or no result', () => {
    expect(sendWarningsNotice({ success: true, messageId: 'wamid.X' })).toBeNull()
    expect(sendWarningsNotice({ success: true, warnings: [] })).toBeNull()
    expect(sendWarningsNotice({ success: false, error: 'x', warnings: ['a'] })).toBeNull()
    expect(sendWarningsNotice(null)).toBeNull()
    expect(sendWarningsNotice(undefined)).toBeNull()
  })

  it('joins every warning, skipping blanks and non-strings', () => {
    const notice = sendWarningsNotice({ success: true, warnings: ['First.', '  ', 42, ' Second. '] })
    expect(notice).toEqual({ title: expect.any(String), message: 'First.\n\nSecond.' })
    expect(notice.title.length).toBeGreaterThan(0)
  })

  it('is null when every warning is blank', () => {
    expect(sendWarningsNotice({ success: true, warnings: ['', '   '] })).toBeNull()
  })

  it('uses no em-dashes in the words staff read', () => {
    const notice = sendWarningsNotice({ success: true, warnings: ['x'] })
    expect(notice.title).not.toMatch(/—/)
  })
})

describe('the WhatsApp thread screen shows send warnings', () => {
  const SCREEN = readFileSync(
    fileURLToPath(new URL('../app/(staff)/whatsapp/[conversationId].jsx', import.meta.url)),
    'utf8',
  )
  it('imports the helper', () => {
    expect(SCREEN).toMatch(/import \{ sendWarningsNotice \} from '\.\.\/\.\.\/\.\.\/lib\/wa-send-warnings'/)
  })
  it('calls it on the text send and the template send', () => {
    expect((SCREEN.match(/sendWarningsNotice\(res\)/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})
