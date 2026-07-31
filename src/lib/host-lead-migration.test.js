import { describe, it, expect, vi } from 'vitest'
import { planHostLeadMigration, runHostLeadMigration } from './host-lead-migration'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

describe('planHostLeadMigration', () => {
  const master = new Map([['ada@x.com', { id: 'm1' }]])
  it('plans a merge for an email match (case-insensitive)', () => {
    expect(planHostLeadMigration([{ id: 'a1', email: 'Ada@X.com' }], master))
      .toEqual([{ action: 'merge', from: 'a1', into: 'm1' }])
  })
  it('plans a move for no match', () => {
    expect(planHostLeadMigration([{ id: 'a2', email: 'new@x.com' }], master))
      .toEqual([{ action: 'move', id: 'a2' }])
  })
  it('never merges contacts without a usable email', () => {
    expect(planHostLeadMigration([{ id: 'a3', email: null }, { id: 'a4', email: '  ' }], master))
      .toEqual([{ action: 'move', id: 'a3' }, { action: 'move', id: 'a4' }])
  })
  it('never merges a contact into itself', () => {
    expect(planHostLeadMigration([{ id: 'm1', email: 'ada@x.com' }], master))
      .toEqual([{ action: 'skip', id: 'm1', reason: 'already master' }])
  })
})

// Hand-rolled supabase-js stand-in, matching the estate's mock idiom: the
// builder is a thenable, selects read from the `rows` fixture, and every
// write (update/delete) is recorded IN ORDER so call sequencing is assertable.
function makeDb(rows) {
  const writes = []
  function run(st) {
    if (st.op === 'select') {
      let data = rows[st.table] || []
      for (const [kind, col, val] of st.filters) {
        data = kind === 'eq' ? data.filter((r) => r[col] === val) : data.filter((r) => val.includes(r[col]))
      }
      if (st.range) data = data.slice(st.range[0], st.range[1] + 1)
      return { data, error: null }
    }
    writes.push({ op: st.op, table: st.table, payload: st.payload, filters: st.filters })
    return { data: null, error: null }
  }
  return {
    writes,
    from(table) {
      const st = { table, op: 'select', filters: [], payload: null, range: null }
      const b = {
        select() { st.op = 'select'; return b },
        update(payload) { st.op = 'update'; st.payload = payload; return b },
        delete() { st.op = 'delete'; return b },
        eq(col, val) { st.filters.push(['eq', col, val]); return b },
        in(col, val) { st.filters.push(['in', col, val]); return b },
        order() { return b },
        range(from, to) { st.range = [from, to]; return b },
        then(resolve, reject) { return Promise.resolve().then(() => run(st)).then(resolve, reject) },
      }
      return b
    },
  }
}

const BASE = {
  locations: [{ id: 'anchor-1', organization_id: 'org-1', is_host_anchor: true }],
  organizations: [{ id: 'org-1', master_location_id: 'master-1' }],
}

describe('runHostLeadMigration', () => {
  it('performs NO writes in dry-run (the default) and returns WOULD-counts', async () => {
    const db = makeDb({
      ...BASE,
      contacts: [
        { id: 'a1', email: 'ada@x.com', tags: ['host:acme'], location_id: 'anchor-1' },
        { id: 'a2', email: 'new@x.com', tags: null, location_id: 'anchor-1' },
        { id: 'm1', email: 'ada@x.com', tags: ['member'], location_id: 'master-1' },
      ],
    })

    const summary = await runHostLeadMigration(db)

    expect(db.writes).toEqual([])
    expect(summary.dry_run).toBe(true)
    expect(summary.planned).toBe(2)
    expect(summary.merged).toBe(1)
    expect(summary.moved).toBe(1)
    expect(summary.errors).toEqual([])
    expect(summary.sample).toEqual([
      { action: 'merge', from: 'a1', into: 'm1' },
      { action: 'move', id: 'a2' },
    ])
  })

  it('a move issues exactly one contacts update with location_id + automations_exempt', async () => {
    const db = makeDb({
      ...BASE,
      contacts: [{ id: 'a2', email: 'new@x.com', tags: null, location_id: 'anchor-1' }],
    })

    const summary = await runHostLeadMigration(db, { dryRun: false })

    expect(summary.moved).toBe(1)
    expect(summary.errors).toEqual([])
    expect(db.writes).toEqual([
      {
        op: 'update',
        table: 'contacts',
        payload: { location_id: 'master-1', automations_exempt: true },
        filters: [['eq', 'id', 'a2']],
      },
    ])
  })

  it('a merge re-points children, drops the anchor preferences, and deletes the anchor contact LAST', async () => {
    const db = makeDb({
      ...BASE,
      contacts: [
        { id: 'a1', email: 'Ada@X.com', tags: ['host:acme'], location_id: 'anchor-1' },
        { id: 'm1', email: 'ada@x.com', tags: ['member'], location_id: 'master-1' },
      ],
    })

    const summary = await runHostLeadMigration(db, { dryRun: false })

    expect(summary.merged).toBe(1)
    expect(summary.errors).toEqual([])

    // Children re-pointed onto the master, never redacted.
    expect(db.writes).toContainEqual({
      op: 'update',
      table: 'whatsapp_conversations',
      payload: { contact_id: 'm1' },
      filters: [['eq', 'contact_id', 'a1']],
    })
    expect(db.writes).toContainEqual({
      op: 'update',
      table: 'host_contacts',
      payload: { contact_id: 'm1' },
      filters: [['eq', 'contact_id', 'a1']],
    })

    // Master consent wins: the anchor's preferences are deleted, not re-pointed.
    expect(db.writes).toContainEqual({
      op: 'delete',
      table: 'contact_preferences',
      payload: null,
      filters: [['eq', 'contact_id', 'a1']],
    })
    expect(db.writes.some((w) => w.table === 'contact_preferences' && w.op === 'update')).toBe(false)

    // The master keeps its own automations_exempt flag — a merge never sets it.
    const masterUpdates = db.writes.filter(
      (w) => w.table === 'contacts' && w.op === 'update' && w.filters[0][2] === 'm1'
    )
    expect(masterUpdates).toEqual([
      { op: 'update', table: 'contacts', payload: { tags: ['member', 'host:acme'] }, filters: [['eq', 'id', 'm1']] },
    ])

    // Ordering is load-bearing: the CASCADE must find nothing left to destroy.
    expect(db.writes[db.writes.length - 1]).toEqual({
      op: 'delete',
      table: 'contacts',
      payload: null,
      filters: [['eq', 'id', 'a1']],
    })
  })
})
