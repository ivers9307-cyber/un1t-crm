// HANDOFFALERT.1 — every "a customer needs a person" push rides the
// agent_handoff category, on both channels and from every sender, so the
// notify_whatsapp / notify_instagram chat switches cannot silence it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AGENT_HANDOFF_PUSH_CATEGORY } from './core'
import { NOTIFICATION_CATEGORIES } from '@/lib/notifications-registry'
import { androidChannelId } from '@shared/push-channels'
import { NOTIFY_KEYS } from '@shared/permissions'

const src = (rel) => readFileSync(resolve(process.cwd(), rel), 'utf8')

describe('the handoff push category', () => {
  it('is registered: a notify key, a registry entry and a heads-up Android channel', () => {
    expect(AGENT_HANDOFF_PUSH_CATEGORY).toBe('agent_handoff')
    expect(NOTIFY_KEYS).toContain(`notify_${AGENT_HANDOFF_PUSH_CATEGORY}`)
    expect(NOTIFICATION_CATEGORIES).toContain(AGENT_HANDOFF_PUSH_CATEGORY)
    expect(androidChannelId({ category: AGENT_HANDOFF_PUSH_CATEGORY })).toBe('messages')
  })

  // The adapters and the SLA sweep's channel list each name the category their
  // staff pushes use. Read as source: importing auto-reply.js drags in the
  // whole agent.
  it.each([
    'src/lib/agent/auto-reply.js',
    'src/lib/agent/instagram.js',
    'src/lib/agent/handoff-sla.js',
  ])('%s sends staff pushes on the handoff category, never a chat category', (file) => {
    const text = src(file)
    const named = [...text.matchAll(/pushCategory:\s*([^,\n]+)/g)].map((m) => m[1].trim())
    expect(named.length).toBeGreaterThan(0)
    for (const value of named) expect(value).toBe('AGENT_HANDOFF_PUSH_CATEGORY')
  })

  it('the undelivered voice reply alert rides it too', () => {
    const text = src('src/lib/wa-voice/reply-fallback.js')
    expect(text).toMatch(/category:\s*AGENT_HANDOFF_PUSH_CATEGORY/)
    expect(text).not.toMatch(/category:\s*'whatsapp'/)
  })
})
