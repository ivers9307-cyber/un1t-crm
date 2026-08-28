// MAIL-SEARCH.2/.6 — the search helper answers TWO questions and unions them:
// which conversations at this location contain this text (FTS over messages),
// and which conversations are FROM someone whose name or address contains it
// (ILIKE over email_tickets requester fields). It applies NO visibility scoping
// and is not allowed to: the list route filters these ids through the same
// query it uses for an unsearched page, so there is exactly one authority on
// who may see what. A second scoping implementation here is how search becomes
// an IDOR.
import { describe, it, expect } from 'vitest'
import {
  searchTicketIds, SEARCH_SCAN_LIMIT, MAX_TICKET_IDS, SENDER_MATCH_LIMIT,
  normalizeQuery,
} from './_search'

/**
 * A fake db that ROUTES BY TABLE AND BY ILIKE COLUMN, because the module now
 * issues three queries: messages FTS, tickets-by-requester_name and
 * tickets-by-requester_email. Each `from()` mints a fresh builder (the real
 * client does too); every call is also recorded into one flat `db.calls` list
 * so assertions about "what was asked" stay simple.
 *
 * `or()` deliberately THROWS. The house rule (CLAUDE.md) is that `.or()` takes
 * a RAW PostgREST filter string, so operator-typed text inside one can rewrite
 * the filter — the sender legs must be two separate `.ilike` queries, and this
 * fake turns any regression into a loud failure rather than a quiet pass.
 */
function makeDb({
  messages = [], messagesError = null,
  senderName = [], senderNameError = null,
  senderEmail = [], senderEmailError = null,
} = {}) {
  const calls = []
  const db = {
    calls,
    from(table) {
      calls.push(['from', table])
      let ilikeColumn = null
      const b = {
        select(cols) { calls.push(['select', cols]); return b },
        eq(col, val) { calls.push(['eq', col, val]); return b },
        not(col, op, val) { calls.push(['not', col, op, val]); return b },
        ilike(col, pattern) { ilikeColumn = col; calls.push(['ilike', col, pattern]); return b },
        textSearch(col, q, opts) { calls.push(['textSearch', col, q, opts]); return b },
        order(col, opts) { calls.push(['order', col, opts]); return b },
        limit(n) { calls.push(['limit', n]); return b },
        or() {
          throw new Error(
            'or() takes a RAW PostgREST filter string — operator text inside one can rewrite the filter. Use separate .ilike queries.'
          )
        },
        then(resolve, reject) {
          let out
          if (table === 'email_inbox_messages') {
            out = { data: messagesError ? null : messages, error: messagesError }
          } else if (ilikeColumn === 'requester_name') {
            out = { data: senderNameError ? null : senderName, error: senderNameError }
          } else if (ilikeColumn === 'requester_email') {
            out = { data: senderEmailError ? null : senderEmail, error: senderEmailError }
          } else {
            out = { data: [], error: null }
          }
          return Promise.resolve(out).then(resolve, reject)
        },
      }
      return b
    },
  }
  return db
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

  // The floor is a typing-debounce, not a scan-cost argument — a single
  // non-stopword character is answered by an ordinary GIN lookup, not a full
  // scan. Two is simply the shortest query worth the round trip.
  it('answers null for a single character', () => {
    expect(normalizeQuery('a')).toBeNull()
    expect(normalizeQuery('ab')).toBe('ab')
  })
})

describe('searchTicketIds — the FTS leg', () => {
  it('returns the DISTINCT ticket ids of matching messages, and does NOT skip', async () => {
    const db = makeDb({ messages: [
      { ticket_id: 't1' }, { ticket_id: 't2' }, { ticket_id: 't1' },
    ] })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ok).toBe(true)
    // A genuine search MUST report skipped:false — Task 3's route reads this
    // field alone to decide whether to apply the search at all. Flip it and
    // the ids are computed and thrown away: the operator types a query, gets
    // the unfiltered inbox back, and nothing downstream notices.
    expect(out.skipped).toBe(false)
    expect([...out.ids].sort()).toEqual(['t1', 't2'])
  })

  it('scopes to the location and to messages that HAVE a conversation', async () => {
    const db = makeDb({ messages: [{ ticket_id: 't1' }] })
    await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(db.calls).toContainEqual(['from', 'email_inbox_messages'])
    expect(db.calls).toContainEqual(['eq', 'location_id', 'loc-1'])
    expect(db.calls).toContainEqual(['not', 'ticket_id', 'is', null])
  })

  it('uses websearch syntax so quotes and OR behave the way an operator expects', async () => {
    const db = makeDb()
    await searchTicketIds(db, { locationId: 'loc-1', q: '"membership freeze"' })
    const ts = db.calls.find(c => c[0] === 'textSearch')
    expect(ts[1]).toBe('search_tsv')
    expect(ts[2]).toBe('"membership freeze"')
    expect(ts[3]).toEqual({ type: 'websearch', config: 'english' })
  })

  // With no ORDER BY, a GIN bitmap heap scan over an append-only table comes
  // back roughly oldest-first — backwards for a mail search, where recent
  // correspondence is what an operator wants. Newest-first is what makes a
  // truncated scan mean "the most recent 1,000 matches" instead of an
  // arbitrary, unstated subset.
  it('orders newest-first so a truncated scan drops the OLDEST matches, not an arbitrary set', async () => {
    const db = makeDb({ messages: [{ ticket_id: 't1' }] })
    await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(db.calls).toContainEqual(['order', 'created_at', { ascending: false }])
  })

  it('caps the scan at SEARCH_SCAN_LIMIT', async () => {
    const db = makeDb({ messages: [{ ticket_id: 't1' }] })
    await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(db.calls).toContainEqual(['limit', SEARCH_SCAN_LIMIT])
  })

  // 🔴 The 1,000-row cap applies to every select. A broad query truncates, and
  // a truncated search reported as complete is a conversation the operator is
  // told does not exist.
  it('flags a truncated scan rather than silently returning a suffix', async () => {
    const rows = Array.from({ length: SEARCH_SCAN_LIMIT }, (_, i) => ({ ticket_id: `t${i}` }))
    const db = makeDb({ messages: rows })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'the' })
    expect(out.partial).toBe(true)
  })

  it('is not partial when the scan came back under the cap', async () => {
    const db = makeDb({ messages: [{ ticket_id: 't1' }] })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.partial).toBe(false)
  })

  // 🔴 A URL BOUND. The caller feeds these to `.in('id', ids)`, which becomes
  // ~39 bytes of query string per id — a thousand of them is a ~39 KB URL, and
  // the proxies in front of this app disagree about how much of that they will
  // carry. A 414 or a truncated query does not read as "your search was broad".
  it('caps how many ids it hands back, and says the answer is incomplete', async () => {
    const rows = Array.from({ length: MAX_TICKET_IDS + 50 }, (_, i) => ({ ticket_id: `t${i}` }))
    const db = makeDb({ messages: rows })

    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })

    expect(out.ids).toHaveLength(MAX_TICKET_IDS)
    expect(out.partial).toBe(true)
    // Newest-first from the scan, so a truncated set is the most RECENT matches.
    expect(out.ids[0]).toBe('t0')
  })

  it('is not partial when the id set fits under the cap', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ ticket_id: `t${i}` }))
    const db = makeDb({ messages: rows })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ids).toHaveLength(5)
    expect(out.partial).toBe(false)
  })

  // A failed search must never read as "no results" — that is the same class as
  // reporting an unreadable mailbox as an empty inbox.
  it('reports a query failure instead of answering an empty result set', async () => {
    const db = makeDb({ messagesError: { message: 'boom' } })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'freeze' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/boom/)
  })

  it('answers "no query" rather than searching for nothing', async () => {
    const db = makeDb()
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: '  ' })
    expect(out.ok).toBe(true)
    expect(out.skipped).toBe(true)
    // null, not [] — a caller that applies `.in('id', ids)` unconditionally on
    // an empty array here would silently render an empty inbox for "no query
    // typed yet". null makes that mistake throw instead.
    expect(out.ids).toBeNull()
    expect(db.calls).toEqual([])
  })

  // Behaviour, not call shape: a missing locationId must be treated exactly
  // like "no query" — including never touching the db — not merely produce a
  // similar-looking response.
  it('treats a missing locationId as no query, and never touches the db', async () => {
    const db = makeDb({ messages: [{ ticket_id: 't1' }] })
    const out = await searchTicketIds(db, { q: 'freeze' })
    expect(out.ok).toBe(true)
    expect(out.skipped).toBe(true)
    expect(out.ids).toBeNull()
    expect(db.calls).toEqual([])
  })
})

// MAIL-SEARCH.6 — the sender leg. The tsvector never indexed
// email_tickets.requester_name at all, so 12 of the 27 named conversations in
// production were unfindable by first name — and the two stopword names
// ('Will', 'Don') were unfindable even when they DID appear in indexed text,
// because websearch_to_tsquery('english', …) discards them into an empty
// query. Names are structured data; matching them structurally fixes both,
// precisely, where widening the FTS config would have drowned "Will" in every
// "I will attend".
describe('searchTicketIds — the sender leg', () => {
  it('finds a conversation by the requester NAME even when no message text matches', async () => {
    const db = makeDb({ messages: [], senderName: [{ id: 't9' }] })

    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'will' })

    expect(out.ok).toBe(true)
    expect(out.ids).toEqual(['t9'])
    expect(db.calls).toContainEqual(['from', 'email_tickets'])
  })

  it('finds a conversation by the requester EMAIL', async () => {
    const db = makeDb({ messages: [], senderEmail: [{ id: 't7' }] })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'fitz' })
    expect(out.ids).toEqual(['t7'])
  })

  it('unions and DEDUPES across all three legs', async () => {
    const db = makeDb({
      messages: [{ ticket_id: 't1' }, { ticket_id: 't2' }],
      senderName: [{ id: 't2' }, { id: 't3' }],
      senderEmail: [{ id: 't3' }, { id: 't4' }],
    })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'byrne' })
    expect([...out.ids].sort()).toEqual(['t1', 't2', 't3', 't4'])
  })

  // 🔴 Under the URL cap, the PERSON matches must survive. Sender hits are the
  // precise ones — an operator searching a name wants that person, and losing
  // them to make room for the 300th body-text match would be the wrong trade
  // every time.
  it('puts sender matches FIRST, so they survive the id cap', async () => {
    const ftsRows = Array.from({ length: MAX_TICKET_IDS }, (_, i) => ({ ticket_id: `t${i}` }))
    const db = makeDb({ messages: ftsRows, senderName: [{ id: 'person-1' }] })

    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'murphy' })

    expect(out.ids).toHaveLength(MAX_TICKET_IDS)
    expect(out.ids[0]).toBe('person-1')
    expect(out.ids).toContain('person-1')
    expect(out.partial).toBe(true)
  })

  // 🔴 The house ILIKE rule. `%` and `_` are LIKE wildcards AND legal email
  // characters, so operator text must be escaped — the deliberate substring
  // wildcards are spelled in the SOURCE, wrapping the escaped term. Without
  // this, searching `a_b` also matches `axb`, and `%` matches everything.
  it('escapes LIKE wildcards in the operator text', async () => {
    const db = makeDb({ messages: [] })
    await searchTicketIds(db, { locationId: 'loc-1', q: 'ann_marie%' })
    const patterns = db.calls.filter(c => c[0] === 'ilike').map(c => c[2])
    expect(patterns).toHaveLength(2)
    for (const p of patterns) expect(p).toBe('%ann\\_marie\\%%')
  })

  // Quotes are websearch syntax ("membership freeze" = a phrase), never part
  // of a name or an address — the FTS leg keeps them, the sender leg strips
  // them so a quoted name still matches the requester fields.
  it('strips websearch quotes for the sender leg but not the FTS leg', async () => {
    const db = makeDb({ messages: [] })
    await searchTicketIds(db, { locationId: 'loc-1', q: '"will byrne"' })
    const ts = db.calls.find(c => c[0] === 'textSearch')
    expect(ts[2]).toBe('"will byrne"')
    const ilikes = db.calls.filter(c => c[0] === 'ilike').map(c => c[2])
    // Length asserted FIRST: iterating an empty list asserts nothing, and this
    // test passed vacuously in its first draft for exactly that reason.
    expect(ilikes).toHaveLength(2)
    for (const p of ilikes) expect(p).toBe('%will byrne%')
  })

  it('location-scopes, orders and bounds BOTH sender legs', async () => {
    const db = makeDb({ messages: [] })
    await searchTicketIds(db, { locationId: 'loc-1', q: 'byrne' })
    const eqLocations = db.calls.filter(c => c[0] === 'eq' && c[1] === 'location_id')
    // messages + two sender legs = three location-scoped queries
    expect(eqLocations).toHaveLength(3)
    const limits = db.calls.filter(c => c[0] === 'limit' && c[1] === SENDER_MATCH_LIMIT)
    expect(limits).toHaveLength(2)
    const orders = db.calls.filter(c => c[0] === 'order' && c[1] === 'last_message_at')
    expect(orders).toHaveLength(2)
  })

  it('asks by requester_name and requester_email as SEPARATE queries, never .or()', async () => {
    // The fake's or() throws, so reaching this assertion at all proves the
    // module never called it. The column split is asserted explicitly too.
    const db = makeDb({ messages: [] })
    await searchTicketIds(db, { locationId: 'loc-1', q: 'byrne' })
    const columns = db.calls.filter(c => c[0] === 'ilike').map(c => c[1]).sort()
    expect(columns).toEqual(['requester_email', 'requester_name'])
  })

  // A failed sender leg must not silently become "that person has no mail" —
  // the same confident-zero lie the whole search feature keeps having to
  // avoid. Both legs are halves of one answer; either failing fails the answer.
  it('reports a sender-leg failure instead of silently omitting the person', async () => {
    const db = makeDb({ messages: [{ ticket_id: 't1' }], senderNameError: { message: 'kaboom' } })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'byrne' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/kaboom/)
  })

  it('reports the email-leg failure too', async () => {
    const db = makeDb({ messages: [], senderEmailError: { message: 'kaboom2' } })
    const out = await searchTicketIds(db, { locationId: 'loc-1', q: 'byrne' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/kaboom2/)
  })
})
