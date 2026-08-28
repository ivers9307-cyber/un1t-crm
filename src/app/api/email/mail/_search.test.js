// MAIL-SEARCH.1 — the search helper answers ONE question: which conversations
// at this location contain this text? It applies NO visibility scoping and is
// not allowed to: the list route filters these ids through the same query it
// uses for an unsearched page, so there is exactly one authority on who may see
// what. A second scoping implementation here is how search becomes an IDOR.
import { describe, it, expect } from 'vitest'
import { searchTicketIds, SEARCH_SCAN_LIMIT, normalizeQuery } from './_search'

function makeDb(rows, error = null) {
  const calls = []
  const b = {
    calls,
    select(cols) { calls.push(['select', cols]); return b },
    eq(col, val) { calls.push(['eq', col, val]); return b },
    not(col, op, val) { calls.push(['not', col, op, val]); return b },
    textSearch(col, q, opts) { calls.push(['textSearch', col, q, opts]); return b },
    limit(n) { calls.push(['limit', n]); return b },
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error }).then(resolve, reject)
    },
  }
  return { from(table) { calls.push(['from', table]); return b }, _b: b }
}

describe('normalizeQuery', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeQuery('  membership   freeze ')).toBe('membership freeze')
  })

  it('answers null for anything with no searchable content', () => {
    expect(normalizeQuery('')).toBeNull()
    expect(normalizeQuery('   ')).toBeNull()
    expect(normalizeQuery(null)).toBeNull()
    expect(normalizeQuery(undefined)).toBeNull()
  })

  // A one-character query matches most of the corpus and costs a full scan to
  // say so. Two is the shortest thing worth running.
  it('answers null for a single character', () => {
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery('ab')).toBe('ab')
  })
})

describe('searchTicketIds', () => {
  it('returns the DISTINCT ticket ids of matching messages', async () => {
    const db = makeDb([
      { ticket_id: 't1' }, { ticket_id: 't2' }, { ticket_id: 't1' },
    ])
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ok).toBe(true)
    expect(out.ids.sort()).toEqual(['t1', 't2'])
  })

  it('scopes to the location and to messages that HAVE a conversation', async () => {
    const db = makeDb([{ ticket_id: 't1' }])
    await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(db._b.calls).toContainEqual(['from', 'email_inbox_messages'])
    expect(db._b.calls).toContainEqual(['eq', 'location_id', 'loc-1'])
    expect(db._b.calls).toContainEqual(['not', 'ticket_id', 'is', null])
  })

  it('uses websearch syntax so quotes and OR behave the way an operator expects', async () => {
    const db = makeDb([])
    await searchTicketIds(db, { locationId: 'loc-1', q: '"membership freeze"' })
    const ts = db._b.calls.find(c => c[0] === 'textSearch')
    expect(ts[1]).toBe('search_tsv')
    expect(ts[2]).toBe('"membership freeze"')
    expect(ts[3]).toEqual({ type: 'websearch', config: 'english' })
  })

  // 🔴 The 1,000-row cap applies to every select. A broad query truncates, and
  // a truncated search reported as complete is a conversation the operator is
  // told does not exist.
  it('flags a truncated scan rather than silently returning a suffix', async () => {
    const rows = Array.from({ length: SEARCH_SCAN_LIMIT }, (_, i) => ({ ticket_id: `t${i}` }))
    const db = makeDb(rows)
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'the' })
    expect(out.partial).toBe(true)
  })

  it('is not partial when the scan came back under the cap', async () => {
    const db = makeDb([{ ticket_id: 't1' }])
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.partial).toBe(false)
  })

  // A failed search must never read as "no results" — that is the same class as
  // reporting an unreadable mailbox as an empty inbox.
  it('reports a query failure instead of answering an empty result set', async () => {
    const db = makeDb(null, { message: 'boom' })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/boom/)
  })

  it('answers "no query" rather than searching for nothing', async () => {
    const db = makeDb([])
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: '  ' })
    expect(out.ok).toBe(true)
    expect(out.skipped).toBe(true)
    expect(db._b.calls).toEqual([])
  })
})
