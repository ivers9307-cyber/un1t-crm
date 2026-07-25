// RADAR-TAKEOVER.1 — an operator pressing "send" on a radar utility
// template (e.g. the outstanding-payment dunning chase) is an intentional
// HUMAN take-over of that WhatsApp thread. Mia must stand down so a reply
// reaches the team, not the agent — same posture as the contact composer
// and the inbox reply route. Ankit Shroff (2026-07-25) got dunned, replied
// "What classes do you run?", and Mia auto-answered with a sales pitch
// because this path never paused her.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the WhatsApp send layer so the unit test never touches Meta or env.
vi.mock('@/lib/whatsapp', () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.TEST' })),
  headerComponentFor: vi.fn(() => null),
  getOrCreateConversation: vi.fn(async () => 'conv-1'),
}))

import { sendRadarOutreach } from './radar-outreach'

const APPROVED_UTILITY = {
  name: 'outstanding_payment_', status: 'APPROVED', category: 'UTILITY', language: 'en',
  components: [{ type: 'BODY', text: 'Hi {{1}}, your membership payment is outstanding.' }],
  header_media_url: null,
}

const CONTACT = { id: 'c1', first_name: 'Ankit', name: 'Ankit Shroff', wa_phone: '353899531579', phone: null }

// Minimal supabase-js-ish builder mock — only the chains this code uses.
function makeDb(template) {
  const captured = { messageInsert: null, convUpdate: null, convUpdateId: null }
  const db = {
    from(tbl) {
      if (tbl === 'whatsapp_templates') {
        return { select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: template ? [template] : [], error: null }) }) }) }) }) }
      }
      if (tbl === 'whatsapp_messages') {
        return { insert: async (row) => { captured.messageInsert = row; return { error: null } } }
      }
      if (tbl === 'whatsapp_conversations') {
        return { update: (patch) => { captured.convUpdate = patch; return { eq: async (_col, val) => { captured.convUpdateId = val; return { error: null } } } } }
      }
      return {}
    },
  }
  return { db, captured }
}

beforeEach(() => vi.clearAllMocks())

describe('sendRadarOutreach — operator send is a human take-over (RADAR-TAKEOVER.1)', () => {
  it('pauses Mia on the thread (agent_active=false) so a reply is not auto-answered', async () => {
    const { db, captured } = makeDb(APPROVED_UTILITY)
    await sendRadarOutreach({ db, contact: CONTACT, templateName: 'outstanding_payment_', locationId: 'loc-1', sentBy: 'user-1' })
    expect(captured.convUpdate).toBeTruthy()
    expect(captured.convUpdate.agent_active).toBe(false)
    expect(captured.convUpdate.agent_handed_off_at).toBeTruthy()
    expect(captured.convUpdateId).toBe('conv-1')
  })

  it('attributes the outbound to the operator (sent_by) so the thread reads as human-owned', async () => {
    const { db, captured } = makeDb(APPROVED_UTILITY)
    await sendRadarOutreach({ db, contact: CONTACT, templateName: 'outstanding_payment_', locationId: 'loc-1', sentBy: 'user-1' })
    expect(captured.messageInsert).toBeTruthy()
    expect(captured.messageInsert.sent_by).toBe('user-1')
  })
})
