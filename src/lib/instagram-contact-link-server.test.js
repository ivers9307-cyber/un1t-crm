// IG-LINK.2 — the resolver is where the auto-link risk actually lives: the
// pure guard only counts what this file hands it, so these tests pin the
// queries themselves. The original defect was here, not in the pure module —
// candidates came from a raw `ilike` while matching was normalised, so
// same-name twins spelled differently returned one row and the "exactly one"
// guard saw a false unique.
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/log', () => ({ logWarn: vi.fn() }))

import { resolveContactForInstagramThread } from './instagram-contact-link-server'

/**
 * Chainable supabase stub that RECORDS the filters applied per table, so a
 * test can assert we looked contacts up the safe way.
 */
function db({ contactsRows = [[]], contactUpdateError = null, convUpdateError = null }) {
  const rows = [...contactsRows]
  const calls = []
  const mk = (table) => {
    const state = { table, op: 'select', filters: {} }
    const finish = () => {
      calls.push(state)
      if (state.op === 'update') {
        return { data: null, error: table === 'contacts' ? contactUpdateError : convUpdateError }
      }
      if (state.op === 'insert') return { data: null, error: null }
      if (table === 'contacts') {
        const next = rows.length ? rows.shift() : []
        return { data: state.single ? (next[0] || null) : next, error: null }
      }
      return { data: null, error: null }
    }
    const b = {
      select: () => b,
      insert: (row) => { state.op = 'insert'; state.row = row; return b },
      update: (row) => { state.op = 'update'; state.row = row; return b },
      eq: (k, v) => { state.filters[k] = v; return b },
      is: (k, v) => { state.filters[k] = v; return b },
      ilike: (k, v) => { state.filters[`ilike:${k}`] = v; return b },
      limit: () => b,
      maybeSingle: () => { state.single = true; return finish() },
      then: (res) => Promise.resolve(finish()).then(res),
    }
    return b
  }
  return { from: (table) => mk(table), _calls: calls }
}

const base = {
  conversationId: 'conv-1',
  locationId: 'loc-1',
  igsid: 'IG_SENDER',
  displayName: 'Sarah Byrne',
  handle: 'sarahb',
}

describe('resolveContactForInstagramThread', () => {
  it('links instantly when the IGSID is already known (no name guessing)', async () => {
    const d = db({ contactsRows: [[{ id: 'known-1' }]] })
    const out = await resolveContactForInstagramThread(d, base)
    expect(out).toBe('known-1')
    const lookup = d._calls[0]
    expect(lookup.filters.instagram_igsid).toBe('IG_SENDER')
    expect(lookup.filters.location_id).toBe('loc-1')
  })

  it('matches names on the NORMALISED column, never a raw ilike', async () => {
    // The regression guard: an ilike here cannot see accent/punctuation twins,
    // which is what made the ambiguity check unsafe.
    const d = db({ contactsRows: [[], [{ id: 'c1', name: 'Sarah Byrne' }]] })
    await resolveContactForInstagramThread(d, base)
    const nameLookup = d._calls[1]
    expect(nameLookup.filters.name_normalized).toBe('sarah byrne')
    expect(nameLookup.filters.location_id).toBe('loc-1')
    expect(Object.keys(nameLookup.filters).some(k => k.startsWith('ilike:'))).toBe(false)
  })

  it('auto-links a unique normalised-name match', async () => {
    const d = db({ contactsRows: [[], [{ id: 'c1', name: 'Sarah Byrne' }]] })
    expect(await resolveContactForInstagramThread(d, base)).toBe('c1')
  })

  it('REFUSES when the normalised name has twins (accent-split included)', async () => {
    const d = db({ contactsRows: [[], [{ id: 'c1', name: 'Sean Byrne' }, { id: 'c2', name: 'Seán Byrne' }]] })
    expect(await resolveContactForInstagramThread(d, { ...base, displayName: 'Sean Byrne' })).toBe(null)
  })

  it('refuses a weak display name without querying by name at all', async () => {
    const d = db({ contactsRows: [[]] })
    expect(await resolveContactForInstagramThread(d, { ...base, displayName: 'Dave' })).toBe(null)
    expect(d._calls.some(c => 'name_normalized' in c.filters)).toBe(false)
  })

  it('refuses when there is no display name to match on', async () => {
    const d = db({ contactsRows: [[]] })
    expect(await resolveContactForInstagramThread(d, { ...base, displayName: null })).toBe(null)
  })

  it('never links a contact already bound to a different instagram account', async () => {
    const d = db({ contactsRows: [[], [{ id: 'c1', name: 'Sarah Byrne', instagram_igsid: 'IG_OTHER' }]] })
    expect(await resolveContactForInstagramThread(d, base)).toBe(null)
  })

  it('backfills the thread messages and stamps the identity when linking', async () => {
    const d = db({ contactsRows: [[], [{ id: 'c1', name: 'Sarah Byrne' }]] })
    await resolveContactForInstagramThread(d, base)
    const msgBackfill = d._calls.find(c => c.table === 'instagram_messages' && c.op === 'update')
    expect(msgBackfill?.row).toEqual({ contact_id: 'c1' })
    expect(msgBackfill?.filters.conversation_id).toBe('conv-1')
    const stamp = d._calls.find(c => c.table === 'contacts' && c.op === 'update')
    expect(stamp?.row).toMatchObject({ instagram_igsid: 'IG_SENDER', instagram_handle: 'sarahb' })
    expect(stamp?.filters.location_id).toBe('loc-1')
  })

  it('reports no link when the conversation update fails', async () => {
    const d = db({
      contactsRows: [[], [{ id: 'c1', name: 'Sarah Byrne' }]],
      convUpdateError: { message: 'db down' },
    })
    expect(await resolveContactForInstagramThread(d, base)).toBe(null)
  })

  it('is inert without the arguments it needs', async () => {
    expect(await resolveContactForInstagramThread(null, base)).toBe(null)
    expect(await resolveContactForInstagramThread(db({}), { ...base, igsid: null })).toBe(null)
  })
})
