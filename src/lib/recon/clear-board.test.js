import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockDb = { from: vi.fn() }
let mod

function chainable(finalValue, terminal) {
  const chain = {}
  for (const m of ['select', 'eq', 'in', 'order', 'range', 'delete', 'insert']) {
    chain[m] = vi.fn().mockReturnThis()
  }
  chain[terminal] = vi.fn().mockResolvedValue(finalValue)
  return chain
}

beforeEach(async () => {
  vi.resetModules()
  mockDb.from.mockReset()
  mod = await import('./clear-board')
})

describe('clearOpenLines', () => {
  it('selects open lines, deletes child hunts BEFORE lines, and audits the clear', async () => {
    const select = chainable({ data: [{ id: 'l1' }, { id: 'l2' }], error: null }, 'range')
    const delHunts = chainable({ error: null }, 'in')
    const delLines = chainable({ error: null }, 'in')
    const audit = chainable({ error: null }, 'insert')
    mockDb.from
      .mockReturnValueOnce(select)   // select open ids
      .mockReturnValueOnce(delHunts) // delete recon_hunts (children first)
      .mockReturnValueOnce(delLines) // delete recon_bank_lines
      .mockReturnValueOnce(audit)    // recon_runs audit insert

    const res = await mod.clearOpenLines(mockDb, 'loc-1', 'user-1')

    expect(res).toEqual({ cleared: 2 })
    // scoped to non-terminal statuses + location
    expect(select.in).toHaveBeenCalledWith('status', ['uncovered', 'submitted', 'not_found', 'needs_attention'])
    expect(select.eq).toHaveBeenCalledWith('location_id', 'loc-1')
    // FK ordering: hunts deleted by bank_line_id, then lines by id
    const order = mockDb.from.mock.calls.map((c) => c[0])
    expect(order).toEqual(['recon_bank_lines', 'recon_hunts', 'recon_bank_lines', 'recon_runs'])
    expect(delHunts.in).toHaveBeenCalledWith('bank_line_id', ['l1', 'l2'])
    expect(delLines.in).toHaveBeenCalledWith('id', ['l1', 'l2'])
    expect(audit.insert).toHaveBeenCalledWith(expect.objectContaining({
      location_id: 'loc-1', trigger: 'clear', status: 'ok',
      stats: { cleared: 2, clearedBy: 'user-1' },
    }))
  })

  it('no-ops the deletes when the board has no open lines but still audits (cleared: 0)', async () => {
    const select = chainable({ data: [], error: null }, 'range')
    const audit = chainable({ error: null }, 'insert')
    mockDb.from.mockReturnValueOnce(select).mockReturnValueOnce(audit)

    const res = await mod.clearOpenLines(mockDb, 'loc-1', 'user-1')
    expect(res).toEqual({ cleared: 0 })
    // only select + audit — no delete calls
    expect(mockDb.from.mock.calls.map((c) => c[0])).toEqual(['recon_bank_lines', 'recon_runs'])
  })

  it('throws with context if the line delete fails (and never reaches audit)', async () => {
    const select = chainable({ data: [{ id: 'l1' }], error: null }, 'range')
    const delHunts = chainable({ error: null }, 'in')
    const delLines = chainable({ error: { message: 'fk boom' } }, 'in')
    mockDb.from
      .mockReturnValueOnce(select)
      .mockReturnValueOnce(delHunts)
      .mockReturnValueOnce(delLines)

    await expect(mod.clearOpenLines(mockDb, 'loc-1', 'user-1')).rejects.toThrow('clear lines failed: fk boom')
  })

  it('does not throw if only the audit insert fails (clear already succeeded)', async () => {
    const select = chainable({ data: [{ id: 'l1' }], error: null }, 'range')
    const delHunts = chainable({ error: null }, 'in')
    const delLines = chainable({ error: null }, 'in')
    const audit = chainable({ error: null }, 'insert')
    audit.insert = vi.fn().mockRejectedValue(new Error('audit down'))
    mockDb.from
      .mockReturnValueOnce(select)
      .mockReturnValueOnce(delHunts)
      .mockReturnValueOnce(delLines)
      .mockReturnValueOnce(audit)

    await expect(mod.clearOpenLines(mockDb, 'loc-1', 'user-1')).resolves.toEqual({ cleared: 1 })
  })
})
