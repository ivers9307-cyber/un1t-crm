import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./glofox.js', () => ({
  glofoxCredentialsForLocation: vi.fn(),
  createGlofoxInteraction: vi.fn(),
}))

import { pushNoteToGlofox } from './glofox-note-push.js'
import { glofoxCredentialsForLocation, createGlofoxInteraction } from './glofox.js'

const CREDS = { branchId: 'b'.repeat(24), token: 't' }

function makeDb(contact, ledgerSpy) {
  return {
    from: (t) => {
      if (t === 'contacts') return { select: () => ({ eq: () => ({ single: async () => ({ data: contact, error: null }) }) }) }
      if (t === 'glofox_note_pushes') return { insert: async (row) => { ledgerSpy(row); return { error: null } } }
      throw new Error(t)
    },
  }
}

beforeEach(() => { vi.clearAllMocks(); glofoxCredentialsForLocation.mockResolvedValue(CREDS); createGlofoxInteraction.mockResolvedValue({ ok: true, status: 200 }) })

describe('pushNoteToGlofox', () => {
  it('pushes a NOTE for a glofox-linked contact and records the ledger', async () => {
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: 'gm1' }, ledger)
    const r = await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', authorName: 'Jane', content: 'hi' })
    expect(r.pushed).toBe(true)
    expect(createGlofoxInteraction).toHaveBeenCalledWith(CREDS, 'gm1', { type: 'NOTE', description: '[UN1T CRM · Jane] hi' })
    expect(ledger.mock.calls[0][0]).toMatchObject({ contact_id: 'c1', location_id: 'l1', glofox_member_id: 'gm1', source_table: 'notes', source_id: 'n1', type: 'NOTE', description: '[UN1T CRM · Jane] hi', status: 'sent' })
  })
  it('skips (no push, no throw) when the contact has no glofox_member_id', async () => {
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: null }, ledger)
    const r = await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', content: 'hi' })
    expect(r.pushed).toBe(false)
    expect(createGlofoxInteraction).not.toHaveBeenCalled()
    expect(ledger).not.toHaveBeenCalled()
  })
  it('skips when there are no glofox creds for the location', async () => {
    glofoxCredentialsForLocation.mockResolvedValue(null)
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: 'gm1' }, ledger)
    const r = await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', content: 'hi' })
    expect(r.pushed).toBe(false)
    expect(createGlofoxInteraction).not.toHaveBeenCalled()
  })
  it('skips when the location has no branch id (non-Glofox location — creds object with null fields)', async () => {
    // glofoxCredentialsForLocation never returns falsy; it returns an object
    // with null fields for a non-Glofox location. Must still skip.
    glofoxCredentialsForLocation.mockResolvedValue({ branchId: null, apiKey: null, apiToken: null, namespace: null, webhookSecret: null })
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: 'gm1' }, ledger)
    const r = await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', content: 'hi' })
    expect(r.pushed).toBe(false)
    expect(createGlofoxInteraction).not.toHaveBeenCalled()
    expect(ledger).not.toHaveBeenCalled()
  })
  it('records status=failed when the Glofox create fails', async () => {
    createGlofoxInteraction.mockResolvedValue({ ok: false, status: 500 })
    const ledger = vi.fn()
    const db = makeDb({ id: 'c1', location_id: 'l1', glofox_member_id: 'gm1' }, ledger)
    await pushNoteToGlofox(db, { contactId: 'c1', sourceTable: 'notes', sourceId: 'n1', type: 'NOTE', content: 'hi' })
    expect(ledger.mock.calls[0][0].status).toBe('failed')
  })
})
