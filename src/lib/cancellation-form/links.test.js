// CANCEL-FORM.3 — the issued-link ledger (cancellation_form_links). The token
// carries only {link id, exp}; these helpers are the map from token to person
// and the single-use / revocation state. Tested against a table-aware
// chainable double that records every write.

import { describe, it, expect, beforeAll } from 'vitest'
import { tokenFingerprint } from '@/lib/consent-token-guard'
import { signCancellationFormToken, verifyCancellationFormToken } from './token.js'
import {
  issueLink, resolveLink, markOpened, claimLink, unclaimLink, attachRequest, revokeLink, latestLinkForContact, buildFormUrl,
} from './links.js'

beforeAll(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-secret-for-cancel-form-links' })

const CONTACT = { id: 'c-1', first_name: 'Aoife', name: 'Aoife Byrne', location_id: 'loc-1', glofox_membership_plan: 'Unlimited' }

// rows: { cancellation_form_links: [...], contacts: [...] }. Filters are
// applied for eq / is so claim predicates behave like Postgres.
function makeDb(rows = {}) {
  const tables = { cancellation_form_links: [], contacts: [], ...rows }
  const writes = []
  function chain(table) {
    const st = { table, op: 'select', filters: [], payload: null, order: null, limit: null }
    const matches = (r) => st.filters.every(([col, val, kind]) => kind === 'is' ? (val === null ? r[col] == null : r[col] === val) : r[col] === val)
    const rowsNow = () => {
      let out = tables[table].filter(matches)
      if (st.order) out = [...out].sort((a, b) => (a[st.order.col] < b[st.order.col] ? 1 : -1) * (st.order.asc ? -1 : 1))
      if (st.limit != null) out = out.slice(0, st.limit)
      return out
    }
    const apply = () => {
      if (st.op === 'insert') { tables[table].push({ ...st.payload }); writes.push({ table, op: 'insert', payload: st.payload }); return [st.payload] }
      if (st.op === 'update') {
        const hit = tables[table].filter(matches)
        hit.forEach((r) => Object.assign(r, st.payload))
        writes.push({ table, op: 'update', payload: st.payload, count: hit.length, filters: st.filters })
        return hit
      }
      return rowsNow()
    }
    const c = {
      select() { return c },
      eq(col, val) { st.filters.push([col, val, 'eq']); return c },
      is(col, val) { st.filters.push([col, val, 'is']); return c },
      order(col, opts = {}) { st.order = { col, asc: opts.ascending !== false }; return c },
      limit(n) { st.limit = n; return c },
      insert(p) { st.op = 'insert'; st.payload = p; return c },
      update(p) { st.op = 'update'; st.payload = p; return c },
      maybeSingle() { const r = apply(); return Promise.resolve({ data: r[0] ?? null, error: null }) },
      single() { const r = apply(); return Promise.resolve(r.length === 1 ? { data: r[0], error: null } : { data: null, error: { message: `rows=${r.length}` } }) },
      then(res, rej) { return Promise.resolve({ data: apply(), error: null }).then(res, rej) },
    }
    return c
  }
  return { from: (t) => chain(t), _tables: tables, _writes: writes }
}

describe('issueLink', () => {
  it('inserts one row with a client-minted id and the token fingerprint, and returns the signed URL', async () => {
    const db = makeDb()
    const now = Date.UTC(2026, 8, 5, 10)
    const out = await issueLink(db, { contactId: 'c-1', locationId: 'loc-1', issuedBy: 'u-1', channel: 'email', baseUrl: 'https://crm.example', now })
    expect(out.ok).toBe(true)
    const row = db._tables.cancellation_form_links[0]
    expect(row.id).toBe(out.linkId)
    expect(row).toMatchObject({ contact_id: 'c-1', location_id: 'loc-1', issued_by: 'u-1', channel: 'email', conversation_id: null })
    expect(row.token_fingerprint).toBe(tokenFingerprint(out.token))
    expect(new Date(row.expires_at).getTime()).toBe(now + 30 * 86400_000)
    expect(verifyCancellationFormToken(out.token, { now }).linkId).toBe(out.linkId)
    expect(out.url).toBe(`https://crm.example/cancel/${out.token}`)
    expect(out.url).not.toContain('c-1')
  })

  it('reports a failed insert instead of returning a URL nobody can use', async () => {
    const db = makeDb()
    db.from = () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) })
    const out = await issueLink(db, { contactId: 'c-1', locationId: 'loc-1', channel: 'email', baseUrl: 'https://crm.example' })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/boom/)
  })
})

describe('buildFormUrl', () => {
  it('joins a base url and token, trimming a trailing slash', () => {
    expect(buildFormUrl('https://un1tdublin.com/', 'abc.def')).toBe('https://un1tdublin.com/cancel/abc.def')
  })
})

describe('resolveLink', () => {
  function issued(db, over = {}) {
    const linkId = 'l-1'
    const token = signCancellationFormToken({ linkId })
    db._tables.cancellation_form_links.push({
      id: linkId, contact_id: 'c-1', location_id: 'loc-1', channel: 'email', conversation_id: null,
      token_fingerprint: tokenFingerprint(token), expires_at: new Date(Date.now() + 86400_000).toISOString(),
      opened_at: null, used_at: null, revoked_at: null, request_id: null, ...over,
    })
    db._tables.contacts.push({ ...CONTACT })
    return token
  }

  it('returns the link and the contact for a live token', async () => {
    const db = makeDb()
    const token = issued(db)
    const out = await resolveLink(db, token)
    expect(out.link.id).toBe('l-1')
    expect(out.contact).toMatchObject({ id: 'c-1', first_name: 'Aoife', glofox_membership_plan: 'Unlimited' })
  })

  it('returns null for a forged, expired-by-row, revoked or fingerprint-mismatched token', async () => {
    expect(await resolveLink(makeDb(), 'garbage')).toBeNull()
    const db1 = makeDb(); issued(db1, { revoked_at: new Date().toISOString() })
    expect(await resolveLink(db1, signCancellationFormToken({ linkId: 'l-1' }))).toBeNull()
    const db2 = makeDb(); issued(db2, { expires_at: new Date(Date.now() - 1000).toISOString() })
    expect(await resolveLink(db2, signCancellationFormToken({ linkId: 'l-1' }))).toBeNull()
    // A validly-signed token for a DIFFERENT issue of the same id must not match.
    const db3 = makeDb(); issued(db3, { token_fingerprint: 'somebody-elses' })
    expect(await resolveLink(db3, signCancellationFormToken({ linkId: 'l-1' }))).toBeNull()
  })

  it('returns null when the contact behind the link is gone', async () => {
    const db = makeDb()
    const token = issued(db)
    db._tables.contacts.length = 0
    expect(await resolveLink(db, token)).toBeNull()
  })
})

describe('claim / open / attach / revoke', () => {
  const seed = (over = {}) => makeDb({ cancellation_form_links: [{ id: 'l-1', opened_at: null, used_at: null, revoked_at: null, request_id: null, send_error: null, ...over }] })

  it('claimLink is single-use: first claim wins, second returns false, revoked cannot be claimed', async () => {
    const db = seed()
    expect(await claimLink(db, 'l-1')).toBe(true)
    expect(db._tables.cancellation_form_links[0].used_at).toBeTruthy()
    expect(await claimLink(db, 'l-1')).toBe(false)
    const revoked = seed({ revoked_at: new Date().toISOString() })
    expect(await claimLink(revoked, 'l-1')).toBe(false)
  })

  it('unclaimLink releases a claim after a failed request insert', async () => {
    const db = seed({ used_at: new Date().toISOString() })
    await unclaimLink(db, 'l-1')
    expect(db._tables.cancellation_form_links[0].used_at).toBeNull()
  })

  it('markOpened stamps once and never overwrites the first open', async () => {
    const db = seed()
    await markOpened(db, 'l-1')
    const first = db._tables.cancellation_form_links[0].opened_at
    expect(first).toBeTruthy()
    await new Promise((r) => setTimeout(r, 2))
    await markOpened(db, 'l-1')
    expect(db._tables.cancellation_form_links[0].opened_at).toBe(first)
  })

  it('attachRequest and revokeLink write what they say', async () => {
    const db = seed()
    await attachRequest(db, 'l-1', 'req-9')
    expect(db._tables.cancellation_form_links[0].request_id).toBe('req-9')
    await revokeLink(db, 'l-1', 'postmark 422')
    expect(db._tables.cancellation_form_links[0].revoked_at).toBeTruthy()
    expect(db._tables.cancellation_form_links[0].send_error).toBe('postmark 422')
  })

  it('latestLinkForContact returns the newest issued row or null', async () => {
    const db = makeDb({ cancellation_form_links: [
      { id: 'old', contact_id: 'c-1', issued_at: '2026-09-01T00:00:00Z' },
      { id: 'new', contact_id: 'c-1', issued_at: '2026-09-04T00:00:00Z' },
      { id: 'other', contact_id: 'c-2', issued_at: '2026-09-05T00:00:00Z' },
    ] })
    expect((await latestLinkForContact(db, 'c-1')).id).toBe('new')
    expect(await latestLinkForContact(db, 'c-3')).toBeNull()
  })
})
