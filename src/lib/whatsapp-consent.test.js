// COMMS-AUDIT 2026-07-10 — STOP keyword partial opt-out.
//
// applyWhatsappConsentKeyword used `.update()` on contact_preferences:
// a contact with NO preferences row matched zero rows, so the
// whatsapp_marketing flag never flipped — only contacts.wa_status got
// set. The marketing audience gate (buildWhatsAppAudience) reads the
// preferences flag, so the contact stayed in marketing audiences after
// replying STOP. The fix upserts by contact_id (same convention as
// marketing-consent.js) so the row is created when missing and updated
// when present. These tests pin the upsert + the unchanged behaviour of
// the denormalised contacts.wa_status write and the consent_log audit.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyWhatsappConsentKeyword, applyMetaUserPreference } from './whatsapp-consent.js'

vi.mock('./whatsapp', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messageId: 'wamid.ack' }),
}))

import { sendTextMessage } from './whatsapp'

// Chainable stub that records every write. `upsert` resolves directly
// (the code awaits the builder); `update` supports the .eq(...) /
// .eq().eq() chains used across the module.
function stubDb({ writes }) {
  return {
    from(table) {
      return {
        upsert: (row, opts) => {
          writes.push({ table, op: 'upsert', row, opts })
          return Promise.resolve({ error: null })
        },
        update: (patch) => {
          const record = (filters) => {
            writes.push({ table, op: 'update', patch, filters })
            return Promise.resolve({ error: null })
          }
          const chain = (filters) => ({
            eq: (col, val) => chain({ ...filters, [col]: val }),
            then: (resolve, reject) => record(filters).then(resolve, reject),
          })
          return chain({})
        },
        insert: (row) => {
          writes.push({ table, op: 'insert', row })
          return Promise.resolve({ error: null })
        },
        select: () => ({
          or: () => ({ limit: () => Promise.resolve({ data: [{ id: 'c1' }] }) }),
        }),
      }
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('applyWhatsappConsentKeyword — STOP', () => {
  it('UPSERTS contact_preferences by contact_id so a contact with no row still opts out', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyWhatsappConsentKeyword({
      db,
      contact: { id: 'c1' },
      waPhone: '353871234567',
      locationId: 'loc1',
      conversationId: 'conv1',
      keyword: 'stop',
    })
    expect(r).toMatchObject({ applied: true, action: 'opted_out' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })
    expect(prefWrite.row.updated_at).toBeTruthy()
    expect(prefWrite.opts).toMatchObject({ onConflict: 'contact_id' })
  })

  it('still sets contacts.wa_status and writes the consent_log audit row', async () => {
    const writes = []
    const db = stubDb({ writes })
    await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'stop',
    })

    const contactWrite = writes.find(w => w.table === 'contacts')
    expect(contactWrite?.patch).toEqual({ wa_status: 'opted_out' })
    expect(contactWrite?.filters).toEqual({ id: 'c1' })

    const logWrite = writes.find(w => w.table === 'consent_log' && w.op === 'insert')
    expect(logWrite?.row).toMatchObject({
      contact_id: 'c1',
      channel: 'whatsapp_marketing',
      action: 'opted_out',
      source: 'whatsapp_keyword',
    })

    // The ack still goes out (their keyword opened the 24h window).
    expect(sendTextMessage).toHaveBeenCalledWith(
      '353871234567',
      expect.stringContaining('unsubscribed'),
      expect.objectContaining({ locationId: 'loc1' }),
    )
  })

  it('START re-opts in via the same upsert', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyWhatsappConsentKeyword({
      db, contact: { id: 'c1' }, waPhone: '353871234567',
      locationId: 'loc1', conversationId: 'conv1', keyword: 'start',
    })
    expect(r).toMatchObject({ applied: true, action: 'opted_in' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: true })
    const contactWrite = writes.find(w => w.table === 'contacts')
    expect(contactWrite?.patch).toEqual({ wa_status: 'active' })
  })

  it('bails without writes on a missing contact or unknown keyword', async () => {
    const writes = []
    const db = stubDb({ writes })
    expect((await applyWhatsappConsentKeyword({ db, contact: null, keyword: 'stop' })).applied).toBe(false)
    expect((await applyWhatsappConsentKeyword({ db, contact: { id: 'c1' }, keyword: 'maybe' })).applied).toBe(false)
    expect(writes).toEqual([])
  })
})

describe('applyMetaUserPreference — same upsert semantics', () => {
  it('stop upserts the preferences row (contact may have none)', async () => {
    const writes = []
    const db = stubDb({ writes })
    const r = await applyMetaUserPreference(db, {
      wa_id: '353871234567', category: 'marketing_messages', value: 'stop',
    })
    expect(r).toMatchObject({ applied: true, action: 'opted_out' })

    const prefWrite = writes.find(w => w.table === 'contact_preferences')
    expect(prefWrite?.op).toBe('upsert')
    expect(prefWrite.row).toMatchObject({ contact_id: 'c1', whatsapp_marketing: false })
    expect(prefWrite.opts).toMatchObject({ onConflict: 'contact_id' })
  })
})
