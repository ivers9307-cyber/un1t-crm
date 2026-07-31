import { describe, it, expect, vi } from 'vitest'
import { planHostLeadMigration, runHostLeadMigration } from './host-lead-migration'

vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logInfo: vi.fn(), logError: vi.fn() }))

describe('planHostLeadMigration', () => {
  const master = new Map([['ada@x.com', { id: 'm1' }]])
  it('flags an email match for manual merge (case-insensitive)', () => {
    expect(planHostLeadMigration([{ id: 'a1', email: 'Ada@X.com' }], master))
      .toEqual([{ action: 'needs_manual_merge', from: 'a1', into: 'm1' }])
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
function makeDb(rows, failWrite) {
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
    return { data: null, error: failWrite ? failWrite(st) || null : null }
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
    expect(summary.moved).toBe(1)
    expect(summary.moved_ids).toEqual(['a2'])
    expect(summary.moved_ids_truncated).toBeUndefined()
    expect(summary.needs_manual_merge).toEqual([{ anchor_id: 'a1', master_id: 'm1' }])
    expect(summary.needs_manual_merge_count).toBe(1)
    expect(summary.needs_manual_merge_truncated).toBeUndefined()
    expect(summary.errors).toEqual([])
    expect(summary).not.toHaveProperty('merged')
  })

  it('a move updates the contact and carries its contact_tags to the master location', async () => {
    const db = makeDb({
      ...BASE,
      contacts: [{ id: 'a2', email: 'new@x.com', location_id: 'anchor-1' }],
    })

    const summary = await runHostLeadMigration(db, { dryRun: false })

    expect(summary.moved).toBe(1)
    expect(summary.moved_ids).toEqual(['a2'])
    expect(summary.errors).toEqual([])
    expect(db.writes).toEqual([
      {
        op: 'update',
        table: 'contacts',
        payload: { location_id: 'master-1', automations_exempt: true },
        // location_id in the filter makes the move TOCTOU-safe: a contact that
        // moved since the scan is left where it now is.
        filters: [['eq', 'id', 'a2'], ['eq', 'location_id', 'anchor-1']],
      },
      {
        // Tag reads are location-scoped, so the tags have to travel or the
        // contact's host:/event: tags vanish from master-scoped segments.
        op: 'update',
        table: 'contact_tags',
        payload: { location_id: 'master-1' },
        filters: [['eq', 'contact_id', 'a2'], ['eq', 'location_id', 'anchor-1']],
      },
    ])
  })

  it('a failed tag re-point is reported but still counts as moved', async () => {
    const db = makeDb(
      { ...BASE, contacts: [{ id: 'a2', email: 'new@x.com', location_id: 'anchor-1' }] },
      (st) => (st.table === 'contact_tags' ? { message: 'tags exploded' } : null)
    )

    const summary = await runHostLeadMigration(db, { dryRun: false })

    // The contact HAS moved — un-counting it would misreport the DB state.
    expect(summary.moved).toBe(1)
    expect(summary.moved_ids).toEqual(['a2'])
    expect(summary.errors).toEqual([{ id: 'a2', message: 'contact_tags move: tags exploded' }])
  })

  // The whole point of HOST-MASTER.7b: an email collision is a REPORT, not an
  // operation. No update, no delete, not even with writes armed.
  it('an email collision performs ZERO writes even with dryRun=false', async () => {
    const db = makeDb({
      ...BASE,
      contacts: [
        { id: 'a1', email: 'Ada@X.com', location_id: 'anchor-1' },
        { id: 'm1', email: 'ada@x.com', location_id: 'master-1' },
      ],
    })

    const summary = await runHostLeadMigration(db, { dryRun: false })

    expect(db.writes).toEqual([])
    expect(summary.planned).toBe(1)
    expect(summary.moved).toBe(0)
    expect(summary.moved_ids).toEqual([])
    expect(summary.needs_manual_merge).toEqual([{ anchor_id: 'a1', master_id: 'm1' }])
    expect(summary.needs_manual_merge_count).toBe(1)
    expect(summary.errors).toEqual([])
  })
})
