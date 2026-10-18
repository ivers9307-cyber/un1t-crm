// MIAHATCH.2 — a turn without a un1t block (no turn at all, glofox, no_booking)
// runs today's code: un1t-tools is never imported (the mock factory only runs on
// an import, so `loaded` stays false) and no un1t table is read. Its own file so
// no other test has loaded the module first.
import { describe, it, expect, vi, beforeEach } from 'vitest'

// The factory only runs when something imports the module, so `loaded` is the
// proof a Glofox-only turn never did.
const probe = vi.hoisted(() => ({ loaded: false, executeUn1tRead: vi.fn(async () => ({ routed: 'un1t' })) }))
vi.mock('./un1t-tools', () => {
  probe.loaded = true
  return { executeUn1tRead: probe.executeUn1tRead }
})
vi.mock('./approval-notify', () => ({ notifyAgentApprovalRequest: vi.fn(async () => {}) }))

import { executeAccountTool } from './account-tools'
import { executeBookingTool } from './booking-tools'

const HATCH = { locationId: 'loc-h', name: 'Hatch', providerKey: 'un1t_online', active: true, answerable: true, contactIds: ['c-1'], un1tUserId: 'u-1' }

// A db that answers every read with nothing and remembers which tables it was asked for.
function recordingDb() {
  const tables = []
  const from = (table) => {
    tables.push(table)
    const b = {
      select: () => b, eq: () => b, in: () => b, order: () => b, limit: () => b, range: () => b, gte: () => b,
      maybeSingle: async () => ({ data: null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject),
    }
    return b
  }
  return { from, tables }
}

const turn = (block) => ({ block, answerable: [HATCH], channel: 'whatsapp', un1tWrites: false })
const ctxOf = (db, over = {}) => ({ db, conversationId: 'conv-1', conversationsTable: 'whatsapp_conversations', contactId: 'c-1', verifiedContactId: 'c-1', locationId: 'loc-h', channel: 'whatsapp', ...over })

beforeEach(() => {
  probe.executeUn1tRead.mockClear()
})


describe('a turn without a un1t block never loads un1t-tools', () => {
  it.each([
    ['no turn at all', undefined],
    ['glofox', turn('glofox')],
    ['no_booking', turn('no_booking')],
  ])('%s', async (_label, t) => {
    const db = recordingDb()
    const ctx = ctxOf(db, t ? { turn: t } : {})
    for (const tool of ['get_my_membership', 'get_my_next_class', 'get_my_recent_attendance']) {
      await executeAccountTool(tool, {}, ctx)
    }
    await executeBookingTool('list_my_upcoming_bookings', {}, ctx)
    expect(probe.loaded).toBe(false)
    expect(probe.executeUn1tRead).not.toHaveBeenCalled()
    expect(db.tables.filter((n) => n.startsWith('un1t_'))).toEqual([])
  })
})
