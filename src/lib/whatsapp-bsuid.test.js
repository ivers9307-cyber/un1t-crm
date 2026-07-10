import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractInboundBsuid, bsuidStampAction, captureInboundBsuid } from './whatsapp-bsuid.js'

describe('extractInboundBsuid', () => {
  it('returns null when contacts array is absent/empty', () => {
    expect(extractInboundBsuid(undefined, '353871234567')).toBeNull()
    expect(extractInboundBsuid(null, '353871234567')).toBeNull()
    expect(extractInboundBsuid([], '353871234567')).toBeNull()
  })

  it('returns null when no user_id on the entry (today\'s payloads)', () => {
    expect(extractInboundBsuid([{ wa_id: '353871234567', profile: { name: 'Amy' } }], '353871234567')).toBeNull()
  })

  it('reads user_id from the entry matching the sender wa_id', () => {
    const contacts = [
      { wa_id: '353870000000', user_id: 'WRONG' },
      { wa_id: '353871234567', user_id: 'bsuid_abc123' },
    ]
    expect(extractInboundBsuid(contacts, '353871234567')).toBe('bsuid_abc123')
  })

  it('falls back to the first entry when no wa_id matches', () => {
    expect(extractInboundBsuid([{ wa_id: 'other', user_id: 'bsuid_first' }], '353871234567')).toBe('bsuid_first')
  })

  it('rejects non-string and blank user_id values', () => {
    expect(extractInboundBsuid([{ wa_id: 'x', user_id: 123 }], 'x')).toBeNull()
    expect(extractInboundBsuid([{ wa_id: 'x', user_id: '   ' }], 'x')).toBeNull()
    expect(extractInboundBsuid([{ wa_id: 'x', user_id: {} }], 'x')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(extractInboundBsuid([{ wa_id: 'x', user_id: ' bsuid_1 ' }], 'x')).toBe('bsuid_1')
  })
})

describe('bsuidStampAction', () => {
  it('noop when there is no incoming bsuid', () => {
    expect(bsuidStampAction(null, null)).toBe('noop')
    expect(bsuidStampAction('bsuid_1', null)).toBe('noop')
    expect(bsuidStampAction('bsuid_1', '')).toBe('noop')
  })

  it('set when nothing is stored yet', () => {
    expect(bsuidStampAction(null, 'bsuid_1')).toBe('set')
    expect(bsuidStampAction(undefined, 'bsuid_1')).toBe('set')
    expect(bsuidStampAction('', 'bsuid_1')).toBe('set')
  })

  it('noop when the stored value already matches', () => {
    expect(bsuidStampAction('bsuid_1', 'bsuid_1')).toBe('noop')
  })

  it('mismatch when a DIFFERENT value is already stored (never overwrite)', () => {
    expect(bsuidStampAction('bsuid_1', 'bsuid_2')).toBe('mismatch')
  })
})

// Minimal supabase-js chain fake: from(table).select(...).eq(...).maybeSingle()
// and from(table).update(patch).eq(...).is(...). Records update patches per table.
function fakeDb(existingByTable) {
  const updates = []
  return {
    updates,
    from(table) {
      return {
        select() { return this },
        eq() { return this },
        maybeSingle: async () => ({ data: existingByTable[table] ?? null, error: null }),
        update(patch) {
          const call = { table, patch }
          updates.push(call)
          return {
            eq() { return this },
            is() { return this },
            then(resolve) { resolve({ data: null, error: null }) },
          }
        },
      }
    },
  }
}

describe('captureInboundBsuid', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does nothing when the payload carries no user_id', async () => {
    const db = fakeDb({})
    await captureInboundBsuid(db, {
      contacts: [{ wa_id: '353871234567' }],
      senderPhone: '353871234567',
      conversationId: 'conv-1',
      contactId: 'contact-1',
    })
    expect(db.updates).toEqual([])
  })

  it('stamps both conversation and contact when unset', async () => {
    const db = fakeDb({
      whatsapp_conversations: { id: 'conv-1', wa_bsuid: null },
      contacts: { id: 'contact-1', wa_bsuid: null },
    })
    await captureInboundBsuid(db, {
      contacts: [{ wa_id: '353871234567', user_id: 'bsuid_1' }],
      senderPhone: '353871234567',
      conversationId: 'conv-1',
      contactId: 'contact-1',
    })
    expect(db.updates).toEqual([
      { table: 'whatsapp_conversations', patch: { wa_bsuid: 'bsuid_1' } },
      { table: 'contacts', patch: { wa_bsuid: 'bsuid_1' } },
    ])
  })

  it('skips rows that already carry the same bsuid', async () => {
    const db = fakeDb({
      whatsapp_conversations: { id: 'conv-1', wa_bsuid: 'bsuid_1' },
      contacts: { id: 'contact-1', wa_bsuid: 'bsuid_1' },
    })
    await captureInboundBsuid(db, {
      contacts: [{ wa_id: 'x', user_id: 'bsuid_1' }],
      senderPhone: 'x',
      conversationId: 'conv-1',
      contactId: 'contact-1',
    })
    expect(db.updates).toEqual([])
  })

  it('warns and never overwrites on a mismatch (identity collision signal)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = fakeDb({
      whatsapp_conversations: { id: 'conv-1', wa_bsuid: 'bsuid_OLD' },
      contacts: { id: 'contact-1', wa_bsuid: 'bsuid_OLD' },
    })
    await captureInboundBsuid(db, {
      contacts: [{ wa_id: 'x', user_id: 'bsuid_NEW' }],
      senderPhone: 'x',
      conversationId: 'conv-1',
      contactId: 'contact-1',
    })
    expect(db.updates).toEqual([])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toMatch(/bsuid/i)
  })

  it('skips the contact leg when the sender is unknown (contactId null)', async () => {
    const db = fakeDb({ whatsapp_conversations: { id: 'conv-1', wa_bsuid: null } })
    await captureInboundBsuid(db, {
      contacts: [{ wa_id: 'x', user_id: 'bsuid_1' }],
      senderPhone: 'x',
      conversationId: 'conv-1',
      contactId: null,
    })
    expect(db.updates).toEqual([{ table: 'whatsapp_conversations', patch: { wa_bsuid: 'bsuid_1' } }])
  })

  it('never throws — DB failure is caught and warned (webhook must survive)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = { from() { throw new Error('column wa_bsuid does not exist') } }
    await expect(captureInboundBsuid(db, {
      contacts: [{ wa_id: 'x', user_id: 'bsuid_1' }],
      senderPhone: 'x',
      conversationId: 'conv-1',
      contactId: 'contact-1',
    })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
