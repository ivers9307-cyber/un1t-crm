// IMPORTLEDGER.1 (audit A08) — the ledger (contact_import_rows) is the
// rollback history: an 'updated' row's before_snapshot is the only copy of the
// contact's pre-import values. A failed ledger chunk used to be logged and
// dropped; now it is retried once and, if still lost, reported as
// ledgerFailed so the caller can mark the batch.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { runImportCommit, ledgerIncompleteMessage, isLedgerIncomplete, LEDGER_INCOMPLETE_PREFIX } from './contact-import-runner.js'
import { logError } from './log.js'

const IMP = 'imp-1'
const MAPPING = { Email: 'email', First: 'first_name' }

function seed() {
  return createFakeDb({
    tables: {
      contact_imports: [{ id: IMP, location_id: 'loc-1', status: 'processing' }],
      contacts: [{ id: 'c-old', location_id: 'loc-1', email: 'old@example.com', first_name: 'Before' }],
      contact_import_rows: [],
    },
  })
}

// Fail the first `times` inserts into contact_import_rows.
function failLedgerInserts(db, times) {
  let left = times
  const from = db.from.bind(db)
  db.from = (table) => {
    const b = from(table)
    const run = b.run.bind(b)
    b.run = () => {
      if (table === 'contact_import_rows' && b.op === 'insert' && left > 0) {
        left -= 1
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      }
      return run()
    }
    return b
  }
  return db
}

const ROWS = [
  { Email: 'old@example.com', First: 'After' },
  { Email: 'new@example.com', First: 'Fresh' },
]
const run = (db) => runImportCommit(db, { importId: IMP, locationId: 'loc-1', mapping: MAPPING, rows: ROWS })

beforeEach(() => vi.clearAllMocks())

describe('runImportCommit ledger', () => {
  it('writes every outcome and reports no loss on a clean run', async () => {
    const db = seed()
    const { counts, ledgerFailed } = await run(db)
    expect(counts).toMatchObject({ created: 1, updated: 1 })
    expect(ledgerFailed).toBe(0)
    const updated = db.tables.contact_import_rows.find((r) => r.action === 'updated')
    expect(updated.before_snapshot).toMatchObject({ first_name: 'Before' })
  })

  it('retries a failed chunk once and keeps the rollback history', async () => {
    const db = failLedgerInserts(seed(), 1)
    const { ledgerFailed } = await run(db)
    expect(ledgerFailed).toBe(0)
    expect(db.tables.contact_import_rows).toHaveLength(2)
    expect(logError).not.toHaveBeenCalled()
  })

  it('reports a chunk lost after the retry instead of discarding it', async () => {
    const db = failLedgerInserts(seed(), 2)
    const { counts, ledgerFailed } = await run(db)
    // The contacts were really written...
    expect(counts).toMatchObject({ created: 1, updated: 1 })
    // ...but their rollback history was not, and the caller is told.
    expect(db.tables.contact_import_rows).toHaveLength(0)
    expect(ledgerFailed).toBe(2)
    expect(logError).toHaveBeenCalledTimes(1)
    const meta = logError.mock.calls[0][2]
    expect(meta).toMatchObject({ importId: IMP, rows: 2, reversibleRows: 2 })
    // Ids and counts only: no row data, no database text.
    expect(JSON.stringify(meta)).not.toContain('example.com')
    expect(JSON.stringify(meta)).not.toContain('timeout')
  })
})

describe('the ledger-incomplete marker', () => {
  it('round-trips through error_message', () => {
    const msg = ledgerIncompleteMessage(3)
    expect(msg.startsWith(LEDGER_INCOMPLETE_PREFIX)).toBe(true)
    expect(isLedgerIncomplete({ error_message: msg })).toBe(true)
    expect(isLedgerIncomplete({ error_message: 'Pending job had no payload.' })).toBe(false)
    expect(isLedgerIncomplete({ error_message: null })).toBe(false)
  })
})
