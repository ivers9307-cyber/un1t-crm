// VOICEREPLY.1 review C1 — a voice reply writes the voice note plus follow-up
// rows (link, buttons, notice) marked with voice_kind; a message the customer
// sent while it went out must still be answered by the missed-inbound rerun.
import { test, expect } from 'vitest'
import { buildReplyTurnMessages } from './core.js'

const t = (n) => `2026-11-04T10:00:0${n}.000+00:00`
const A = { direction: 'inbound', message_type: 'audio', body: '', transcript_status: 'ok', transcript: 'Can I book Thursday?', created_at: t(1) }
const R1 = { direction: 'outbound', message_type: 'audio', body: 'Yes, book here', source: 'agent', voice_kind: 'lead', created_at: t(2) }
const B = { direction: 'inbound', message_type: 'text', body: 'actually Friday', created_at: t(3) }
const R1f = { direction: 'outbound', message_type: 'text', body: 'Yes, book here https://x.test/b', source: 'agent', voice_kind: 'lead', created_at: t(4) }

test('a late message after a voice reply with a follow-up is still answered', () => {
  const r = buildReplyTurnMessages([A, R1, B, R1f], { answeredThroughIso: t(1) })
  expect(r.reason).toBeNull()
  expect(r.messages.at(-1)).toEqual({ role: 'user', content: 'actually Friday' })
})

test('the late message landing before the voice note row is answered too', () => {
  const Bearly = { ...B, created_at: '2026-11-04T10:00:01.500+00:00' }
  const r = buildReplyTurnMessages([A, Bearly, R1, R1f], { answeredThroughIso: t(1) })
  expect(r.reason).toBeNull()
  expect(r.messages.at(-1).content).toBe('actually Friday')
})

test('a separate later reply (no voice_kind follow-up) still means already answered', () => {
  const R2 = { direction: 'outbound', message_type: 'text', body: 'Friday works too', source: 'agent', created_at: t(5) }
  const r = buildReplyTurnMessages([A, R1, R1f, B, R2], { answeredThroughIso: t(1) })
  expect(r.reason).toBe('nothing_to_answer')
})
