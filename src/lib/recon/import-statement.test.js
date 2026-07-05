import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = { from: vi.fn() }

let imp

function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'not', 'gte', 'lte', 'order', 'update', 'upsert', 'range']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  imp = await import('./import-statement')
})

const LINES = [
  { key: 'csv:aaa', date: '2026-06-03', amount: -84.5, description: 'MUSCLEFOOD LTD', reference: 'CARD 1234' },
  { key: 'csv:bbb', date: '2026-06-10', amount: -12, description: 'COFFEE SUPPLIES', reference: '' },
  { key: 'csv:ccc', date: '2026-06-12', amount: -230, description: 'ELECTRIC IRELAND', reference: 'DD 8871' },
]

describe('importStatementLines', () => {
  it('inserts fresh lines, skips cross-source (date,amount) dupes and already-tracked keys, covers reconciled re-uploads', async () => {
    const existing = chainable({
      data: [
        // API-tracked line, same date+amount as csv:ccc → cross-source dupe
        { id: 'row-bt', xero_line_key: 'bt:xyz', line_date: '2026-06-12', amount: -230 },
        // csv line tracked from a previous upload → alreadyTracked
        { id: 'row-b', xero_line_key: 'csv:bbb', line_date: '2026-06-10', amount: -12 },
        // csv line the new upload reports as reconciled → covered
        { id: 'row-old', xero_line_key: 'csv:old', line_date: '2026-05-01', amount: -50 },
      ],
      error: null,
    }, 'range')
    const inserted = chainable({ data: null, error: null }, 'upsert')
    const covered = chainable({ data: null, error: null }, 'in')
    mockDb.from
      .mockReturnValueOnce(existing)
      .mockReturnValueOnce(inserted)
      .mockReturnValueOnce(covered)

    const stats = await imp.importStatementLines(mockDb, {
      locationId: 'loc-1',
      bankAccountId: 'acct-1',
      bankAccountName: 'Current',
      lines: LINES,
      reconciledKeys: ['csv:old'],
    })

    expect(stats).toEqual({ tracked: 1, duplicates: 1, alreadyTracked: 1, covered: 1 })
    // only csv:aaa inserts — csv:bbb already tracked, csv:ccc dupes the bt line
    expect(inserted.upsert).toHaveBeenCalledTimes(1)
    const [rows, opts] = inserted.upsert.mock.calls[0]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ xero_line_key: 'csv:aaa', status: 'uncovered', bank_account_name: 'Current' })
    expect(opts).toEqual({ onConflict: 'location_id,xero_line_key', ignoreDuplicates: true })
    // cover targets the tracked csv row by id — never bt rows
    expect(covered.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'covered' }))
    expect(covered.in).toHaveBeenCalledWith('id', ['row-old'])
  })

  it('never vanish-covers: lines absent from the upload are left untouched', async () => {
    const existing = chainable({
      data: [{ id: 'row-x', xero_line_key: 'csv:absent', line_date: '2026-06-01', amount: -9 }],
      error: null,
    }, 'range')
    const inserted = chainable({ data: null, error: null }, 'upsert')
    mockDb.from.mockReturnValueOnce(existing).mockReturnValueOnce(inserted)

    const stats = await imp.importStatementLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      lines: [LINES[0]], reconciledKeys: [],
    })
    expect(stats.covered).toBe(0)
    // 2 from() calls only: select + insert — no cover update issued
    expect(mockDb.from).toHaveBeenCalledTimes(2)
  })

  it('no-ops cleanly on an upload with nothing trackable', async () => {
    const stats = await imp.importStatementLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      lines: [], reconciledKeys: [],
    })
    expect(stats).toEqual({ tracked: 0, duplicates: 0, alreadyTracked: 0, covered: 0 })
    expect(mockDb.from).not.toHaveBeenCalled()
  })

  it('surfaces insert failures with context', async () => {
    const existing = chainable({ data: [], error: null }, 'range')
    const inserted = chainable({ data: null, error: { message: 'boom' } }, 'upsert')
    mockDb.from.mockReturnValueOnce(existing).mockReturnValueOnce(inserted)
    await expect(imp.importStatementLines(mockDb, {
      locationId: 'loc-1', bankAccountId: 'acct-1', bankAccountName: 'Current',
      lines: [LINES[0]], reconciledKeys: [],
    })).rejects.toThrow('statement import insert failed: boom')
  })
})
