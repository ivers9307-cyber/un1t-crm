// RETIRE-SHIFTS-MIRROR.6 — tests for publishNotifyRowsForBlocks, which
// sources the publish notify-list from the Roster v2 model (assignments on
// the newly-published blocks) instead of the dropped public.shifts flip.
import { describe, it, expect } from 'vitest'
import { publishNotifyRowsForBlocks } from './roster-notify'

function makeDb(result) {
  const builder = {
    select() { return this },
    in() { return this },
    then(resolve) { return Promise.resolve(result).then(resolve) },
  }
  return { from() { return builder } }
}

describe('publishNotifyRowsForBlocks', () => {
  it('returns [] for an empty block list without querying', async () => {
    let queried = false
    const db = { from() { queried = true; return {} } }
    expect(await publishNotifyRowsForBlocks(db, [])).toEqual([])
    expect(queried).toBe(false)
  })

  it('maps assignments to notify rows { id, profile_id, location_id, shift_date }', async () => {
    const db = makeDb({
      data: [
        { id: 'a1', profile_id: 'p1', shift_blocks: { location_id: 'loc1', block_date: '2026-06-08' } },
        { id: 'a2', profile_id: 'p2', shift_blocks: { location_id: 'loc1', block_date: '2026-06-09' } },
      ],
      error: null,
    })
    const rows = await publishNotifyRowsForBlocks(db, ['b1', 'b2'])
    expect(rows).toEqual([
      { id: 'a1', profile_id: 'p1', location_id: 'loc1', shift_date: '2026-06-08' },
      { id: 'a2', profile_id: 'p2', location_id: 'loc1', shift_date: '2026-06-09' },
    ])
  })

  it('skips assignments with no joined block and swallows query errors', async () => {
    const partial = makeDb({ data: [{ id: 'a1', profile_id: 'p1', shift_blocks: null }], error: null })
    expect(await publishNotifyRowsForBlocks(partial, ['b1'])).toEqual([])

    const bad = makeDb({ data: null, error: { message: 'boom' } })
    expect(await publishNotifyRowsForBlocks(bad, ['b1'])).toEqual([])
  })
})
