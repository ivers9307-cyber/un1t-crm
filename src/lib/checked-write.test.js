import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createFakeDb } from '../../tests/helpers/fake-db.js'

vi.mock('@/lib/log', () => ({ logError: vi.fn() }))
import { logError } from '@/lib/log'
import { checkedWrite } from './checked-write.js'

const ID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
let db
beforeEach(() => {
  vi.clearAllMocks()
  db = createFakeDb({ tables: { promo_codes: [{ id: ID, redeemed_count: 1 }] } })
})
const bump = (id) => () => db.from('promo_codes').update({ redeemed_count: 2 }).eq('id', id).select('id')

describe('checkedWrite', () => {
  it('a write that touched the rows it should is ok and logs nothing', async () => {
    const r = await checkedWrite('t', bump(ID), { expectRows: 1 })
    expect(r).toMatchObject({ ok: true, rows: 1, error: null })
    expect(db.tables.promo_codes[0].redeemed_count).toBe(2)
    expect(logError).not.toHaveBeenCalled()
  })

  it('an update that matched nothing is a failure when rows are expected', async () => {
    const r = await checkedWrite('t', bump(OTHER), { expectRows: 1, message: 'count not bumped', meta: { promo: OTHER } })
    expect(r).toMatchObject({ ok: false, rows: 0, error: null })
    expect(logError).toHaveBeenCalledWith('t', 'count not bumped', { promo: OTHER, rows: 0, expected_rows: 1, attempts: 1 })
  })

  it("'some' accepts any number of rows above zero", async () => {
    expect((await checkedWrite('t', bump(ID), { expectRows: 'some' })).ok).toBe(true)
    expect((await checkedWrite('t', bump(OTHER), { expectRows: 'some' })).ok).toBe(false)
  })

  it('a database error is a failure, logged with the error', async () => {
    db = createFakeDb({ tables: { promo_codes: [] }, errors: { promo_codes: { update: { message: 'down' } } } })
    const r = await checkedWrite('t', bump(ID))
    expect(r.ok).toBe(false)
    expect(logError).toHaveBeenCalledWith('t', 'write failed', { err: { message: 'down' }, attempts: 1 })
  })

  it('without expectRows, a write with no error is ok even if it touched nothing', async () => {
    expect((await checkedWrite('t', bump(OTHER))).ok).toBe(true)
  })

  it('a throw is a failure, not an exception for the caller', async () => {
    const err = new Error('network')
    const r = await checkedWrite('t', () => { throw err })
    expect(r).toMatchObject({ ok: false, error: err })
  })

  it('retries send the write again and stop at the first success', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: 'blip' } })
      .mockResolvedValueOnce({ data: [{ id: ID }], error: null })
    const r = await checkedWrite('t', run, { expectRows: 1, retries: 2 })
    expect(r.ok).toBe(true)
    expect(run).toHaveBeenCalledTimes(2)
    expect(logError).not.toHaveBeenCalled()
  })

  it('gives up after the last retry and logs once', async () => {
    const run = vi.fn(async () => ({ data: null, error: { message: 'down' } }))
    expect((await checkedWrite('t', run, { retries: 1 })).ok).toBe(false)
    expect(run).toHaveBeenCalledTimes(2)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError.mock.calls[0][2].attempts).toBe(2)
  })
})
