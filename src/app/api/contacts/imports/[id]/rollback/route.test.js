// POST /api/contacts/imports/[id]/rollback, on the schema-checked fake DB.
//
// C9 — the closing stamps used to be bare `await`s with the error discarded.
// supabase-js does NOT throw on a failed write — it resolves with `{ error }` —
// so a failed stamp was invisible. The route still returns 200 with the real
// counts (the reversal genuinely happened) and names the stamps that did not
// land in `stamp_failed`.
//
// IMPORTROLLBACK.1 (audit A09) — a partial rollback used to stamp EVERY row and
// the batch rolled_back, so the failed rows could never be retried. Now only
// finished rows are stamped, the batch goes back to 'completed' when anything
// is left, and a second POST redoes only the unfinished rows. The claim must
// actually claim the batch.
//
// IMPORTLEDGER.1 (audit A08) — a batch whose rollback history was not fully
// saved answers ledger_incomplete:true rather than a clean full restore.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../../../../../../tests/helpers/fake-db.js'
import { ledgerIncompleteMessage } from '@/lib/contact-import-runner'

vi.mock('@/lib/contact-merge', () => ({ redactWhatsAppForContact: vi.fn(async () => {}) }))
vi.mock('@/lib/log', () => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/auth', () => ({
  getCurrentUser: vi.fn(),
  assertLocationAccessOr404: vi.fn(() => null),
}))

let db
vi.mock('@/lib/supabase', () => ({ createServerClient: () => db }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { logError } from '@/lib/log'

const MASTER = { id: 'user-1', isMaster: true, role: 'master' }
const IMP = 'imp-1'
const ERR = { code: '40001', message: 'could not serialize access due to concurrent update' }

function seed({ status = 'completed', error_message = null, created = ['c1'], updated = [['c9', { first_name: 'Ann' }]] } = {}) {
  const contacts = []
  const rows = []
  let n = 2
  for (const id of created) {
    contacts.push({ id, location_id: 'loc-1', created_via_import_id: IMP, first_name: 'New' })
    rows.push({ id: `row-${id}`, import_id: IMP, row_number: n++, action: 'created', contact_id: id, raw_row: {}, before_snapshot: null })
  }
  for (const [id, snap] of updated) {
    contacts.push({ id, location_id: 'loc-1', created_via_import_id: null, first_name: 'Imported' })
    rows.push({ id: `row-${id}`, import_id: IMP, row_number: n++, action: 'updated', contact_id: id, raw_row: {}, before_snapshot: snap })
  }
  return createFakeDb({
    tables: {
      contact_imports: [{ id: IMP, location_id: 'loc-1', status, error_message }],
      contacts,
      contact_import_rows: rows,
    },
  })
}

// Run `before(builder)` ahead of every query, and fail the ones `pred` picks.
// The fake's own `errors` option fails a whole table+op; these tests need one row.
function intercept(fake, { pred = () => false, before = () => {} } = {}) {
  const from = fake.from.bind(fake)
  fake.from = (table) => {
    const b = from(table)
    const run = b.run.bind(b)
    b.run = () => {
      before(b)
      if (pred(b)) {
        fake.calls.push({ table, op: b.op, filters: b.log, injected: true })
        return { data: null, error: ERR }
      }
      return run()
    }
    return b
  }
  return fake
}
const filterValue = (b, column) => b.log.find((f) => f.column === column)?.value
const isRestoreOf = (id) => (b) => b.table === 'contacts' && b.op === 'update' && filterValue(b, 'id') === id

const props = { params: Promise.resolve({ id: IMP }) }
const post = () => POST(new Request('http://localhost/x', { method: 'POST' }), props)
const batchRow = () => db.tables.contact_imports[0]
const rowAction = (id) => db.tables.contact_import_rows.find((r) => r.id === id).action

beforeEach(() => {
  vi.clearAllMocks()
  getCurrentUser.mockResolvedValue(MASTER)
})

describe('the happy path', () => {
  it('reverses every row, stamps them and the batch rolled_back', async () => {
    db = seed()
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ deleted: 1, restored: 1, failed: 0, partial: false, ledger_incomplete: false, stamp_failed: [] })
    expect(db.tables.contacts.map((c) => c.id)).toEqual(['c9'])
    expect(db.tables.contacts[0].first_name).toBe('Ann')
    expect(rowAction('row-c1')).toBe('rolled_back')
    expect(rowAction('row-c9')).toBe('rolled_back')
    expect(batchRow()).toMatchObject({ status: 'rolled_back', rolled_back_by: 'user-1' })
  })

  it('an updated row with nothing to restore is finished and counted, not retried for ever', async () => {
    db = seed({ updated: [['c9', null], ['c8', { not_a_column: 'x' }], ['c7', { first_name: 'Bo' }]] })
    const body = await (await post()).json()
    expect(body.data).toMatchObject({ restored: 1, failed: 0, unrestorable: 2, partial: false })
    expect(['row-c9', 'row-c8', 'row-c7'].map(rowAction)).toEqual(['rolled_back', 'rolled_back', 'rolled_back'])
    expect(batchRow().status).toBe('rolled_back')
  })

  it('still refuses an import that is already rolled back', async () => {
    db = seed({ status: 'rolled_back' })
    const res = await post()
    expect(res.status).toBe(400)
  })
})

describe('the claim must claim the batch (A09)', () => {
  it('refuses with 409 and changes nothing when the batch is not completed', async () => {
    for (const status of ['pending', 'processing', 'failed']) {
      db = seed({ status })
      const res = await post()
      expect(res.status).toBe(409)
      expect((await res.json()).success).toBe(false)
      expect(db.tables.contacts).toHaveLength(2)
      expect(batchRow().status).toBe(status)
    }
  })

  it('refuses with 409 when another rollback claimed the batch between the read and the claim', async () => {
    db = intercept(seed(), {
      before: (b) => {
        if (b.table === 'contact_imports' && b.op === 'update' && b.payload?.status === 'rolling_back') {
          batchRow().status = 'rolling_back' // the other request won
        }
      },
    })
    const res = await post()
    expect(res.status).toBe(409)
    expect(db.tables.contacts).toHaveLength(2)
    expect(rowAction('row-c1')).toBe('created')
  })

  it('still re-runs a batch stranded at rolling_back', async () => {
    db = seed({ status: 'rolling_back' })
    const res = await post()
    expect(res.status).toBe(200)
    expect(batchRow().status).toBe('rolled_back')
  })

  it('answers a fixed string, not database text, when the claim write fails', async () => {
    db = intercept(seed(), {
      pred: (b) => b.table === 'contact_imports' && b.op === 'update' && b.payload?.status === 'rolling_back',
    })
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain('serialize')
    expect(db.tables.contacts).toHaveLength(2)
  })
})

describe('a partial rollback is retryable (A09)', () => {
  it('leaves the failed row pending and the batch retryable', async () => {
    db = intercept(seed({ updated: [['c8', { first_name: 'Bea' }], ['c9', { first_name: 'Ann' }]] }), {
      pred: isRestoreOf('c9'),
    })
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ deleted: 1, restored: 1, failed: 1, partial: true })
    expect(rowAction('row-c1')).toBe('rolled_back')
    expect(rowAction('row-c8')).toBe('rolled_back')
    expect(rowAction('row-c9')).toBe('updated')
    expect(batchRow().status).toBe('completed')
    expect(batchRow().rolled_back_at ?? null).toBeNull()
  })

  it('a second attempt repairs only the unfinished row', async () => {
    let failing = true
    db = intercept(seed({ updated: [['c8', { first_name: 'Bea' }], ['c9', { first_name: 'Ann' }]] }), {
      pred: (b) => failing && isRestoreOf('c9')(b),
    })
    await post()
    failing = false
    // Someone edits c8 by hand after its successful restore. A re-run that
    // redid finished rows would overwrite that edit.
    db.tables.contacts.find((c) => c.id === 'c8').first_name = 'Edited later'
    db.calls.length = 0

    const body = await (await post()).json()
    expect(body.data).toMatchObject({ deleted: 0, restored: 1, failed: 0, partial: false })
    const contactWrites = db.calls.filter((c) => c.table === 'contacts' && c.op !== 'select')
    expect(contactWrites).toHaveLength(1)
    expect(contactWrites[0].filters).toContainEqual({ column: 'id', op: 'eq', value: 'c9' })
    expect(db.tables.contacts.find((c) => c.id === 'c8').first_name).toBe('Edited later')
    expect(db.tables.contacts.find((c) => c.id === 'c9').first_name).toBe('Ann')
    expect(rowAction('row-c9')).toBe('rolled_back')
    expect(batchRow().status).toBe('rolled_back')
  })

  it('keeps a created row whose delete failed, and finishes it on the retry', async () => {
    let failing = true
    db = intercept(seed({ created: ['c1', 'c2'], updated: [] }), {
      pred: (b) => failing && b.table === 'contacts' && b.op === 'delete' && filterValue(b, 'id') === 'c2',
    })
    const first = await (await post()).json()
    expect(first.data).toMatchObject({ deleted: 1, failed: 1, partial: true })
    expect(rowAction('row-c1')).toBe('rolled_back')
    expect(rowAction('row-c2')).toBe('created')
    failing = false
    const second = await (await post()).json()
    expect(second.data).toMatchObject({ deleted: 1, failed: 0, partial: false })
    expect(rowAction('row-c2')).toBe('rolled_back')
    expect(batchRow().status).toBe('rolled_back')
  })
})

describe('closing stamps are not silent (C9)', () => {
  it('reports a failed batch stamp, still 200 with the real counts, logged with the id', async () => {
    db = intercept(seed({ created: ['c1', 'c2'] }), {
      pred: (b) => b.table === 'contact_imports' && b.op === 'update' && b.payload?.status === 'rolled_back',
    })
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ deleted: 2, restored: 1 })
    expect(body.data.stamp_failed).toContain('batch')
    expect(logError).toHaveBeenCalled()
    expect(JSON.stringify(logError.mock.calls.at(-1)[2])).toContain(IMP)
    // Stranded at rolling_back, which stays re-runnable.
    expect(batchRow().status).toBe('rolling_back')
  })

  it('a failed row stamp leaves the batch retryable rather than rolled_back', async () => {
    let failing = true
    db = intercept(seed(), { pred: (b) => failing && b.table === 'contact_import_rows' && b.op === 'update' })
    const body = await (await post()).json()
    expect(body.data.stamp_failed).toEqual(['rows'])
    expect(body.data.partial).toBe(true)
    expect(batchRow().status).toBe('completed')
    failing = false
    const again = await (await post()).json()
    expect(again.data).toMatchObject({ partial: false, stamp_failed: [] })
    expect(batchRow().status).toBe('rolled_back')
  })
})

describe('an import with incomplete rollback history (A08)', () => {
  it('does not claim a full restore', async () => {
    db = seed({ error_message: ledgerIncompleteMessage(500) })
    const body = await (await post()).json()
    expect(body.data.ledger_incomplete).toBe(true)
  })
})
