// src/lib/whatsapp-coexistence-ingest.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
// WAORGNUMBER.5 — the thread's studio is routeInboundThread's (its rules are
// whatsapp-inbound-route.test.js). Default: the number's home studio and the
// peer's thread there, read through the test's db, switched on.
vi.mock('./whatsapp-inbound-route', () => ({
  routeInboundThread: vi.fn(async (db, { numberHomeLocationId, waPhone }) => {
    const { data } = await db.from('whatsapp_conversations').select('id, whatsapp_number_id')
      .eq('location_id', numberHomeLocationId).eq('wa_phone', waPhone).limit(1).maybeSingle()
    return { locationId: numberHomeLocationId, conversation: data || null, by: 'number_home', switchedOn: true }
  }),
}))
const { logError } = await import('@/lib/log')
const { routeInboundThread } = await import('./whatsapp-inbound-route')
const { syncContactMatchOnly, ingestCoexistenceMessage } = await import('./whatsapp-coexistence-ingest.js')

// Minimal chainable mock db. Each .from() returns a builder whose terminal
// awaited call resolves to the queued result for that table+op.
function makeDb(handlers) {
  return {
    from(table) {
      const ctx = { table, filters: [] }
      const builder = {
        select() { return builder }, insert(v) { ctx.op = 'insert'; ctx.values = v; return builder },
        update(v) { ctx.op = 'update'; ctx.values = v; return builder },
        eq(c, v) { ctx.filters.push(['eq', c, v]); return builder }, is(c, v) { ctx.filters.push(['is', c, v]); return builder },
        neq(c, v) { ctx.filters.push(['neq', c, v]); return builder },
        in(c, v) { ctx.filters.push(['in', c, v]); return builder },
        or(f) { ctx.filters.push(['or', f]); return builder },
        limit() { return builder }, order() { return builder },
        maybeSingle() { return Promise.resolve(handlers(ctx)) },
        single() { return Promise.resolve(handlers(ctx)) },
        then(res) { return Promise.resolve(handlers(ctx)).then(res) },
      }
      return builder
    },
  }
}

describe('syncContactMatchOnly', () => {
  it('updates wa_phone on an EXISTING contact and never creates', async () => {
    const updates = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'contacts' && ctx.op === 'update') { updates.push(ctx.values); return { data: null, error: null } }
      if (ctx.table === 'contacts') return { data: { id: 'c1', wa_phone: null }, error: null } // match found
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353861234567' })
    expect(r).toEqual({ matched: true, contactId: 'c1' })
    expect(updates).toEqual([{ wa_phone: '353861234567' }])
  })
  it('creates NOTHING when the contact is not already in the CRM', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'insert') { inserts.push(ctx); return { data: { id: 'X' }, error: null } }
      if (ctx.table === 'contacts') return { data: null, error: null } // no match
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353860000000' })
    expect(r).toEqual({ matched: false, contactId: null })
    expect(inserts).toEqual([]) // never inserts a contact
  })
})

// W0.2 — the organisation fence. The fake answers `locations` the way the
// real table would for L1 (org-1) with one sibling L2, so the real
// siblingLocationIds runs and the recorded `contacts` query carries the scope.
function locationsHandler(ctx) {
  if (ctx.table !== 'locations') return undefined
  if (ctx.filters.some(([k]) => k === 'neq')) return { data: [{ id: 'L2' }], error: null }
  return { data: { id: 'L1', organization_id: 'org-1' }, error: null }
}

describe('W0.2 — coexistence contact matches stay inside the receiving organisation', () => {
  it('syncContactMatchOnly scopes the phone match to [receiving, sibling]', async () => {
    const contactReads = []
    const db = makeDb((ctx) => {
      const loc = locationsHandler(ctx); if (loc) return loc
      if (ctx.table === 'contacts' && ctx.op !== 'update') { contactReads.push(ctx.filters); return { data: { id: 'c1', wa_phone: '353861234567' }, error: null } }
      return { data: null, error: null }
    })
    const r = await syncContactMatchOnly(db, { phone: '+353861234567', locationId: 'L1' })
    expect(r).toEqual({ matched: true, contactId: 'c1' })
    expect(contactReads).toHaveLength(1)
    expect(contactReads[0]).toContainEqual(['in', 'location_id', ['L1', 'L2']])
    expect(contactReads[0].some(([k]) => k === 'or')).toBe(true)
  })

  it('ingestCoexistenceMessage scopes the peer match to [receiving, sibling]', async () => {
    const contactReads = []
    const db = makeDb((ctx) => {
      const loc = locationsHandler(ctx); if (loc) return loc
      if (ctx.table === 'contacts') { contactReads.push(ctx.filters); return { data: { id: 'c1' }, error: null } }
      if (ctx.op === 'insert') return { data: { id: 'n1' }, error: null }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.F1', peerPhone: '353222', direction: 'inbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toMatchObject({ inserted: true, contactId: 'c1' })
    expect(contactReads).toHaveLength(1)
    expect(contactReads[0]).toContainEqual(['in', 'location_id', ['L1', 'L2']])
  })

  it('a failed locations read narrows to the receiving location (never the sentinel-less estate)', async () => {
    const contactReads = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'locations') return { data: null, error: { message: 'boom' } }
      if (ctx.table === 'contacts') { contactReads.push(ctx.filters); return { data: null, error: null } }
      return { data: null, error: null }
    })
    await syncContactMatchOnly(db, { phone: '+353861234567', locationId: 'L1' })
    expect(contactReads[0]).toContainEqual(['in', 'location_id', ['L1']])
  })
})

describe('ingestCoexistenceMessage', () => {
  it('dedups on wa_message_id — a message we already have is skipped', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages' && ctx.op !== 'insert') return { data: { id: 'existing' }, error: null } // dupe found
      if (ctx.op === 'insert') { inserts.push(ctx.table); return { data: { id: 'n' }, error: null } }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.DUP', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'duplicate' })
    expect(inserts).toEqual([]) // no conversation, no message
  })

  it('recovers from a conversation-insert unique-race and still stores the message', async () => {
    const inserts = []
    let convSelects = 0
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages') {
        if (ctx.op === 'insert') { inserts.push('msg'); return { data: { id: 'm1' }, error: null } }
        return { data: null, error: null } // dedup: not a dupe
      }
      if (ctx.table === 'contacts') return { data: null, error: null } // unknown peer
      if (ctx.table === 'whatsapp_conversations') {
        if (ctx.op === 'insert') return { data: null, error: { message: 'duplicate key' } } // lost the race
        convSelects += 1
        // 1st select = existing-conv lookup (none); 2nd = re-read the winner
        return convSelects === 1 ? { data: null, error: null } : { data: { id: 'raced1' }, error: null }
      }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.RACE', peerPhone: '353999', direction: 'inbound', messageType: 'text', body: 'hi', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: true, conversationId: 'raced1', contactId: null })
    expect(inserts).toEqual(['msg']) // still inserted despite losing the conversation race
  })

  it('reports failure when the final message insert errors', async () => {
    const db = makeDb((ctx) => {
      if (ctx.table === 'whatsapp_messages') {
        if (ctx.op === 'insert') return { data: null, error: { message: 'boom' } }
        return { data: null, error: null } // dedup: not a dupe
      }
      if (ctx.table === 'contacts') return { data: null, error: null } // unknown peer
      if (ctx.table === 'whatsapp_conversations') {
        if (ctx.op === 'insert') return { data: { id: 'conv1' }, error: null }
        return { data: null, error: null } // no existing conv
      }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.BOOM', peerPhone: '353888', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'boom' })
  })

  it('rejects a malformed descriptor with no valid direction before touching the db', async () => {
    const inserts = []
    const db = makeDb((ctx) => {
      if (ctx.op === 'insert') { inserts.push(ctx.table); return { data: { id: 'n' }, error: null } }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, {
      locationId: 'L1', descriptor: { waMessageId: 'wamid.BAD', peerPhone: '353777', direction: undefined, messageType: 'text', body: 'x', tsSeconds: 1700000000 },
    })
    expect(r).toEqual({ inserted: false, reason: 'bad_direction' })
    expect(inserts).toEqual([]) // guarded before any write
  })
})

// C106 CHECKINRISKS.1 (d) — a reply typed in the studio's linked WhatsApp
// Business phone app reaches us as an smb_message_echoes webhook. It is a
// STAFF message: stored as source 'app_echo' (the CHECK has allowed it since
// mig 259; nothing wrote it), and it takes the thread over from Mia exactly
// like an inbox send (manualTakeoverPatch). History-sync rows stay as they
// were: the column default, and no take-over (they are weeks old).
describe('ingestCoexistenceMessage — phone-app echoes are staff (C106 d)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  // A new peer thread: no dupe, no contact, the conversation insert wins.
  function echoDb({ convUpdateError = null, stampError = null } = {}) {
    const writes = []
    const db = makeDb((ctx) => {
      if (ctx.op) writes.push({ table: ctx.table, op: ctx.op, values: ctx.values, filters: ctx.filters })
      if (ctx.table === 'whatsapp_messages') return { data: ctx.op === 'insert' ? { id: 'm1' } : null, error: null }
      if (ctx.table === 'contacts') return { data: null, error: null }
      if (ctx.table === 'whatsapp_conversations') {
        if (ctx.op === 'insert') return { data: { id: 'conv1' }, error: null }
        if (ctx.op === 'update') {
          const isStamp = 'last_message_at' in (ctx.values || {})
          return { data: null, error: isStamp ? stampError : convUpdateError }
        }
        return { data: null, error: null }
      }
      return { data: null, error: null }
    })
    return { db, writes }
  }
  const echo = { waMessageId: 'wamid.E1', peerPhone: '353000', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000, origin: 'echo' }
  const history = { ...echo, waMessageId: 'wamid.H1', origin: 'history' }

  it("stores an echo with source 'app_echo' and no sent_by", async () => {
    const { db, writes } = echoDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv1' })
    const msg = writes.find(w => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msg.values.source).toBe('app_echo')
    expect(msg.values).not.toHaveProperty('sent_by')
  })

  it('an echo takes the thread over from Mia, like an inbox send', async () => {
    const { db, writes } = echoDb()
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    const upd = writes.find(w => w.table === 'whatsapp_conversations' && w.op === 'update')
    expect(upd).toBeTruthy()
    expect(upd.values.agent_active).toBe(false)
    expect(typeof upd.values.agent_handed_off_at).toBe('string')
  })

  it('a history-sync row keeps the column default and takes nothing over', async () => {
    const { db, writes } = echoDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: history })
    expect(r).toEqual({ inserted: true, conversationId: 'conv1', contactId: null })
    const msg = writes.find(w => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msg.values).not.toHaveProperty('source')
    expect(writes.some(w => w.table === 'whatsapp_conversations' && w.op === 'update')).toBe(false)
  })

  it('a descriptor with no origin is treated as history (never staff by accident)', async () => {
    const { db, writes } = echoDb()
    const { origin, ...bare } = echo
    expect(origin).toBe('echo')
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: bare })
    const msg = writes.find(w => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msg.values).not.toHaveProperty('source')
    expect(writes.some(w => w.op === 'update')).toBe(false)
  })

  it('a failed take-over write is logged and reported; the message is still stored', async () => {
    const { db } = echoDb({ convUpdateError: { message: 'update refused' } })
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv1', takeoverFailed: true })
    expect(logError).toHaveBeenCalledWith('wa-coexistence', expect.stringMatching(/take-over/i),
      expect.objectContaining({ conversationId: 'conv1', locationId: 'L1', err: 'update refused' }))
  })

  it('a failed message insert takes nothing over', async () => {
    const writes = []
    const db = makeDb((ctx) => {
      if (ctx.op) writes.push({ table: ctx.table, op: ctx.op })
      if (ctx.table === 'whatsapp_messages') return ctx.op === 'insert' ? { data: null, error: { message: 'boom' } } : { data: null, error: null }
      if (ctx.table === 'whatsapp_conversations') return ctx.op === 'insert' ? { data: { id: 'conv1' }, error: null } : { data: null, error: null }
      return { data: null, error: null }
    })
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toEqual({ inserted: false, reason: 'boom' })
    expect(writes.some(w => w.op === 'update')).toBe(false)
  })

  // WA-APPECHO.2 — the inbox ordering. Every other send path (the inbox send
  // route, Mia, the inbound webhook) stamps the conversation's last_message_*
  // columns; an echo did not, so a thread answered from the phone stayed in
  // "Needs reply" (last_message_direction 'inbound') and never moved up.
  const stampOf = (writes) => writes.find(w => w.table === 'whatsapp_conversations' && w.op === 'update' && 'last_message_at' in w.values)

  it('an echo bumps the thread: last_message_at / direction / preview, at the echo time', async () => {
    const { db, writes } = echoDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: { ...echo, body: 'y'.repeat(150) } })
    expect(r).toEqual({ inserted: true, conversationId: 'conv1', contactId: null })
    const stamp = stampOf(writes)
    expect(stamp.values).toEqual({
      last_message_at: new Date(1700000000 * 1000).toISOString(),
      last_message_direction: 'outbound',
      last_message_preview: 'y'.repeat(100),
    })
    expect(stamp.filters).toContainEqual(['eq', 'id', 'conv1'])
  })

  it('the bump never moves a thread backwards past a newer message (ordering guard)', async () => {
    const { db, writes } = echoDb()
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    const iso = new Date(1700000000 * 1000).toISOString()
    expect(stampOf(writes).filters).toContainEqual(['or', `last_message_at.is.null,last_message_at.lt.${iso}`])
  })

  it('a caption-less media echo previews as its type, like the inbound webhook', async () => {
    const { db, writes } = echoDb()
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: { ...echo, messageType: 'image', body: '' } })
    expect(stampOf(writes).values.last_message_preview).toBe('[image]')
  })

  it('the take-over still applies when the bump is skipped or fails', async () => {
    const { db, writes } = echoDb({ stampError: { message: 'stamp refused' } })
    const r = await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: echo })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv1', stampFailed: true })
    const takeover = writes.find(w => w.table === 'whatsapp_conversations' && w.op === 'update' && 'agent_active' in w.values)
    expect(takeover.values.agent_active).toBe(false)
    expect(logError).toHaveBeenCalledWith('wa-coexistence', expect.stringMatching(/inbox/i),
      expect.objectContaining({ conversationId: 'conv1', err: 'stamp refused' }))
    // never a message body in a log line
    for (const call of logError.mock.calls) expect(JSON.stringify(call)).not.toContain('"x"')
  })

  it('a history row does not bump the thread (weeks old)', async () => {
    const { db, writes } = echoDb()
    await ingestCoexistenceMessage(db, { locationId: 'L1', descriptor: history })
    expect(stampOf(writes)).toBeUndefined()
  })
})

// WAORGNUMBER.5 (R4) — a phone-app echo / history row files where the inbound
// router says, and the receiving number is stamped when it is switched on
// there, or (transitionally, WAHOMESTUDIO.1) the thread is at a number-less
// home studio.
describe('ingestCoexistenceMessage — the inbound router decides the thread (WAORGNUMBER.5)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function routedDb(existing = null) {
    const writes = []
    const db = makeDb((ctx) => {
      if (ctx.op) writes.push({ table: ctx.table, op: ctx.op, values: ctx.values, filters: ctx.filters })
      if (ctx.table === 'whatsapp_messages') return { data: ctx.op === 'insert' ? { id: 'm1' } : null, error: null }
      if (ctx.table === 'contacts') return { data: { id: 'k1', location_id: 'loc-hatch' }, error: null }
      if (ctx.table === 'whatsapp_conversations') return { data: ctx.op === 'insert' ? { id: 'conv1' } : (ctx.op ? null : existing), error: null }
      return { data: null, error: null }
    })
    return { db, writes }
  }
  const echoAt = { waMessageId: 'wamid.HOME1', peerPhone: '353222', direction: 'outbound', messageType: 'text', body: 'x', tsSeconds: 1700000000, origin: 'echo' }
  const convInsert = (writes) => writes.find((w) => w.table === 'whatsapp_conversations' && w.op === 'insert')

  it('asks the router with the receiving number, its home, its organisation and the matched contact', async () => {
    const { db } = routedDb()
    await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', organizationId: 'org-1', descriptor: echoAt })
    expect(routeInboundThread).toHaveBeenCalledWith(db, {
      numberId: 'wn-1', numberHomeLocationId: 'loc-still', organizationId: 'org-1', waPhone: '353222', bsuid: null,
      contact: { id: 'k1', location_id: 'loc-hatch' }, contextMessageId: null, referral: null,
      now: 1700000000 * 1000, // the message's own time, not the import's
    })
  })

  it('numberless_home: the thread is at the number-less home studio, stamped with the receiving number', async () => {
    routeInboundThread.mockResolvedValueOnce({ locationId: 'loc-hatch', conversation: null, by: 'numberless_home', switchedOn: false })
    const { db, writes } = routedDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: echoAt })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv1', contactId: 'k1' })
    expect(convInsert(writes).values).toMatchObject({ location_id: 'loc-hatch', contact_id: 'k1', whatsapp_number_id: 'wn-1' })
    const msgInsert = writes.find((w) => w.table === 'whatsapp_messages' && w.op === 'insert')
    expect(msgInsert.values).toMatchObject({ location_id: 'loc-hatch', conversation_id: 'conv1', contact_id: 'k1' })
  })

  it('a studio the number is switched on at gets a stamped thread (R4 step 6)', async () => {
    routeInboundThread.mockResolvedValueOnce({ locationId: 'loc-hatch', conversation: null, by: 'recent', switchedOn: true })
    const { db, writes } = routedDb()
    await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: echoAt })
    expect(convInsert(writes).values).toEqual({ location_id: 'loc-hatch', contact_id: 'k1', wa_phone: '353222', status: 'active', whatsapp_number_id: 'wn-1' })
  })

  it('a studio the number is NOT switched on at (and not number-less) gets an unstamped thread', async () => {
    routeInboundThread.mockResolvedValueOnce({ locationId: 'loc-still', conversation: null, by: 'number_home', switchedOn: false })
    const { db, writes } = routedDb()
    await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: echoAt })
    expect(convInsert(writes).values).toEqual({ location_id: 'loc-still', contact_id: 'k1', wa_phone: '353222', status: 'active' })
  })

  it('no receiving number: never stamps', async () => {
    const { db, writes } = routedDb()
    await ingestCoexistenceMessage(db, { locationId: 'loc-still', descriptor: echoAt })
    expect(convInsert(writes).values).not.toHaveProperty('whatsapp_number_id')
  })
})

// F4 (R3 completeness) — an EXISTING thread with no stamp gets the receiving
// number, or a reply into it has no number to resolve. Logged, never thrown;
// the message is stored either way.
describe('ingestCoexistenceMessage — an existing unstamped thread is stamped (F4)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  function homeDb({ updateError = null } = {}) {
    const writes = []
    const db = makeDb((ctx) => {
      if (ctx.op) writes.push({ table: ctx.table, op: ctx.op, values: ctx.values, filters: ctx.filters })
      if (ctx.table === 'whatsapp_messages') return { data: ctx.op === 'insert' ? { id: 'm1' } : null, error: null }
      if (ctx.table === 'contacts') return { data: { id: 'k1', location_id: 'loc-hatch' }, error: null }
      if (ctx.table === 'whatsapp_conversations' && ctx.op === 'update') return { data: null, error: updateError }
      return { data: null, error: null }
    })
    return { db, writes }
  }
  const routedTo = (existing) => routeInboundThread.mockResolvedValueOnce({ locationId: 'loc-hatch', conversation: existing, by: 'numberless_home', switchedOn: false })
  const inbound = { waMessageId: 'wamid.HOME9', peerPhone: '353222', direction: 'inbound', messageType: 'text', body: 'x', tsSeconds: 1700000000 }
  const stampWrites = (writes) => writes.filter((w) => w.table === 'whatsapp_conversations' && w.op === 'update' && 'whatsapp_number_id' in (w.values || {}))

  it('stamps the existing thread with the receiving number, only while it is unstamped', async () => {
    routedTo({ id: 'conv-h', whatsapp_number_id: null })
    const { db, writes } = homeDb()
    const r = await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: inbound })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv-h' })
    expect(stampWrites(writes)).toEqual([{
      table: 'whatsapp_conversations', op: 'update', values: { whatsapp_number_id: 'wn-1' },
      filters: [['eq', 'id', 'conv-h'], ['is', 'whatsapp_number_id', null]],
    }])
  })

  it('leaves an already-stamped thread alone', async () => {
    routedTo({ id: 'conv-h', whatsapp_number_id: 'wn-9' })
    const { db, writes } = homeDb()
    await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: inbound })
    expect(stampWrites(writes)).toEqual([])
  })

  it('a failed stamp is logged and the message is still stored', async () => {
    routedTo({ id: 'conv-h', whatsapp_number_id: null })
    const { db, writes } = homeDb({ updateError: { message: 'boom' } })
    const r = await ingestCoexistenceMessage(db, { locationId: 'loc-still', numberId: 'wn-1', descriptor: inbound })
    expect(r).toMatchObject({ inserted: true, conversationId: 'conv-h' })
    expect(writes.some((w) => w.table === 'whatsapp_messages' && w.op === 'insert')).toBe(true)
    expect(logError).toHaveBeenCalledWith('wa-coexistence', 'number stamp on the existing thread failed (replies into it have no number)', {
      conversationId: 'conv-h', locationId: 'loc-hatch', numberId: 'wn-1', err: 'boom',
    })
  })
})
