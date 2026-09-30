// INBOXLOC.1 (C37) — the phone's WhatsApp thread screen acts at the
// CONVERSATION's studio. It used to send every call (thread GET, send,
// template send and list, card sets, Flow, resolve, block, react, feedback)
// with the ACTIVE studio, so a thread opened from a contact at another studio
// was refused, or offered the active studio's templates and card sets. The
// decision is threadLocationId (mobile/lib/wa-thread-location.js, tested);
// there is no RN component test runner, so this pins the screen's use of it:
// `activeLocation` is read only as threadLocationId's fallback.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { stripComments } from '../scripts/lib/strip-comments.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCREEN = path.join(ROOT, 'mobile/app/(staff)/whatsapp/[conversationId].jsx')

describe('INBOXLOC.1 — phone WhatsApp thread screen', () => {
  const code = stripComments(readFileSync(SCREEN, 'utf8'))

  it('names activeLocation only to read it from the auth context and as threadLocationId\'s fallback', () => {
    const uses = code.split('\n').filter((line) => /\bactiveLocation\b/.test(line))
    const stray = uses.filter((line) => !/const \{ activeLocation \} = useAuth\(\)/.test(line) && !/threadLocationId\([^)]*activeLocation/.test(line))
    expect(stray).toEqual([])
  })

  it('decides the studio with threadLocationId', () => {
    expect(code).toMatch(/import \{ threadLocationId \} from '\.\.\/\.\.\/\.\.\/lib\/wa-thread-location'/)
    expect(code).toMatch(/threadLocationId\(/)
  })
})
