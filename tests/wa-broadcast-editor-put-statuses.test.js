// C123 GATES-4 (a) — PUT /api/whatsapp/broadcasts/[id] no longer accepts
// status 'sending' | 'sent' (only /send starts a send). This pins that the
// web callers never PUT either: every status literal WABroadcastEditor.jsx
// PUTs is one the route still takes. Source guard (no DOM runner for it).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/components/WABroadcastEditor.jsx', import.meta.url), 'utf8')

describe('WABroadcastEditor PUT statuses', () => {
  it('only draft and cancelled are PUT', () => {
    const statuses = [...src.matchAll(/JSON\.stringify\(\{[^}]*status:\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(statuses.sort()).toEqual(['cancelled', 'draft'])
  })
  it('the send goes through /send', () => {
    expect(src).toMatch(/\/api\/whatsapp\/broadcasts\/\$\{broadcastId\}\/send/)
  })
})
