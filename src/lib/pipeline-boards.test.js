import { describe, it, expect, vi } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import {
  listBoards, getBoard, createBoard, updateBoard, setBoardEnabled, boardLocationId,
  SWITCH_OFF_FIRST_ERROR, UN1T_STUDIO_ERROR, LEGACY_BOARD_ERROR,
} from './pipeline-boards.js'
import { fakeDb } from './pipeline-boards.test-helpers.js'

const LOC = 'a0000000-0000-0000-0000-000000000001'
const OTHER = 'a0000000-0000-0000-0000-000000000002'

// What the wizard posts: no trusted slugs.
const clientConfig = (over = {}) => ({
  entry: { type: 'trial_purchase', match: 'plan_code', values: ['TRIAL39'] },
  stages: [
    { role: 'new', name: 'New', slug: 'whatever' },
    { role: 'first_class', name: '1st Class' },
    { role: 'checkpoint', name: 'Day 7', day: 7 },
    { role: 'done', name: 'Done' },
  ],
  duration_days: 14,
  ...over,
})

const seedDb = (source = 'glofox', extra = {}) => fakeDb({
  locations: [{ id: LOC, membership_source: source }, { id: OTHER, membership_source: 'glofox' }],
  pipelines: [{ id: 'legacy1', location_id: LOC, key: 'acquisition', name: 'Acquisition', board_type: null, enabled: true, is_primary: true, priority: 100, config: {}, display_order: 1 }],
  ...extra,
})

async function createdBoard(db, over = {}) {
  const res = await createBoard(db, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: clientConfig(), priority: 50, createdBy: 'u1', ...over })
  expect(res.ok).toBe(true)
  return res.board
}

const stageBySlug = (board, slug) => board.stages.find((s) => s.slug === slug)

describe('createBoard', () => {
  it('createsOffBoardWithStages', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    expect(db.calls.rpc).toHaveLength(1)
    const args = db.calls.rpc[0].args
    expect(args.p_key).toBe('o_reset_39')
    expect(args.p_board_type).toBe('offer')
    expect(args.p_module).toBe('offer')
    expect(args.p_recipe_key).toBe('paid_trial_offer')
    expect(args.p_priority).toBe(50)
    expect(args.p_created_by).toBe('u1')
    expect(args.p_stages.map((s) => s.slug)).toEqual(['o_reset_39_new', 'o_reset_39_first_class', 'o_reset_39_day_7', 'o_reset_39_done'])
    expect(args.p_config.stages.map((s) => s.slug)).toEqual(args.p_stages.map((s) => s.slug))
    expect(args.p_stages[2]).toMatchObject({ stage_role: 'checkpoint', role_config: { day: 7 }, display_order: 902 })
    expect(board).toMatchObject({ key: 'o_reset_39', enabled: false, board_type: 'offer', baseline_at: null })
    expect(board.stages.map((s) => s.slug)).toEqual(args.p_stages.map((s) => s.slug))
    expect(board.stages.every((s) => s.deal_count === 0)).toBe(true)
  })

  it('createTwiceSameNameGetsSecondKey', async () => {
    const db = seedDb()
    const a = await createdBoard(db)
    const b = await createdBoard(db)
    expect(a.key).toBe('o_reset_39')
    expect(b.key).toBe('o_reset_39_2')
    expect(stageBySlug(b, 'o_reset_39_2_new')).toBeTruthy()
  })

  it('retriesOnceOnA23505ThenGivesKeyTaken', async () => {
    const db = seedDb()
    db.failures.create_configured_pipeline = [{ code: '23505' }]
    const ok = await createdBoard(db)
    expect(db.calls.rpc.map((c) => c.args.p_key)).toEqual(['o_reset_39', 'o_reset_39_2'])
    expect(ok.key).toBe('o_reset_39_2')

    const db2 = seedDb()
    db2.failures.create_configured_pipeline = [{ code: '23505' }, { code: '23505' }]
    const res = await createBoard(db2, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'key_taken' })
    expect(db2.calls.rpc).toHaveLength(2)
  })

  it('refusesUn1tStudio', async () => {
    const db = seedDb('un1t_online')
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 409, error: UN1T_STUDIO_ERROR })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('unreadableMembershipSourceIs503', async () => {
    const db = seedDb()
    db.failures['locations:select'] = { message: 'down' }
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 503 })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('refusesUnknownRecipe', async () => {
    const db = seedDb()
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'nope', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'unknown_recipe' })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('badConfigIs400WithIssues', async () => {
    const db = seedDb()
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config: clientConfig({ entry: { type: 'trial_purchase', match: 'plan_code', values: [] } }) })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'invalid_config' })
    expect(res.issues).toEqual(expect.arrayContaining([{ path: 'config', message: 'entry.values needs at least one value' }]))
    expect(db.calls.rpc).toHaveLength(0)
  })
})

describe('listBoards / getBoard', () => {
  it('listsEveryBoardWithOpenDealCountsAndNoLegacyConfig', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const newStage = stageBySlug(board, 'o_reset_39_new')
    db.tables.deals.push(
      { id: 'd1', location_id: LOC, stage_id: newStage.id, status: 'open' },
      { id: 'd2', location_id: LOC, stage_id: newStage.id, status: 'won' },
      { id: 'd3', location_id: OTHER, stage_id: newStage.id, status: 'open' },
    )
    db.tables.pipeline_stage_followups.push({ id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: newStage.id, pack_key: 'book_first_class', state: 'live', want_live: true, version: 1, sequence_id: 's1', whatsapp_template_id: 't1' })
    const res = await listBoards(db, LOC)
    expect(res.ok).toBe(true)
    expect(res.boards.map((b) => b.key)).toEqual(['acquisition', 'o_reset_39'])
    expect(res.boards[0].config).toBeNull()
    const offer = res.boards[1]
    expect(offer.config.entry.values).toEqual(['TRIAL39'])
    expect(stageBySlug(offer, 'o_reset_39_new').deal_count).toBe(1)
    expect(offer.followups).toEqual([{ id: 'f1', stage_id: newStage.id, pack_key: 'book_first_class', state: 'live', want_live: true, version: 1, sequence_id: 's1', whatsapp_template_id: 't1' }])
  })

  it('getBoardIs404AtAnotherStudio', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    expect(await getBoard(db, OTHER, board.id)).toMatchObject({ ok: false, status: 404 })
    expect(await boardLocationId(db, board.id)).toEqual({ ok: true, locationId: LOC })
    expect(await boardLocationId(db, 'nope')).toMatchObject({ ok: false, status: 404 })
  })

  it('unreadableDealsIs503NotZero', async () => {
    const db = seedDb()
    await createdBoard(db)
    db.failures['deals:select'] = { message: 'down' }
    expect(await listBoards(db, LOC)).toMatchObject({ ok: false, status: 503 })
  })
})

describe('updateBoard', () => {
  const editableConfig = (board, mutate) => {
    const c = structuredClone(board.config)
    mutate(c)
    return c
  }

  it('patchStructureWhileOnIs409', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    const cases = [
      { config: editableConfig(board, (c) => { c.entry.values = ['OTHER'] }) },
      { config: editableConfig(board, (c) => { c.duration_days = 21 }) },
      { config: editableConfig(board, (c) => { c.quiet_days = 30 }) },
      { config: editableConfig(board, (c) => { c.stages.push({ role: 'converted', name: 'Converted' }) }) },
      { config: editableConfig(board, (c) => { c.stages = c.stages.filter((s) => s.role !== 'done') }) },
      { priority: 7 },
    ]
    for (const patch of cases) {
      const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch })
      expect(res).toMatchObject({ ok: false, status: 409, code: 'switch_off_first', error: SWITCH_OFF_FIRST_ERROR })
    }
    expect(db.calls.updates.filter((u) => u.table === 'pipeline_stages')).toHaveLength(0)
  })

  it('patchNameWhileOnAllowed', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'done').name = 'Trial over'
      c.mia_notes = 'Be kind.'
      c.offer_name = '14 Day Reset'
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { name: 'Reset 39 euro', config, priority: board.priority } })
    expect(res.ok).toBe(true)
    expect(res.board.name).toBe('Reset 39 euro')
    expect(res.board.enabled).toBe(true)
    expect(res.board.key).toBe('o_reset_39')
    expect(stageBySlug(res.board, 'o_reset_39_done').name).toBe('Trial over')
    expect(res.board.config).toMatchObject({ mia_notes: 'Be kind.', offer_name: '14 Day Reset' })
    const write = db.calls.updates.filter((u) => u.table === 'pipelines').at(-1)
    expect(write.patch.updated_at).toEqual(expect.any(String))
  })

  it('addsAStageWhileOff', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const config = editableConfig(board, (c) => { c.stages.push({ role: 'converted', name: 'Converted' }) })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(stageBySlug(res.board, 'o_reset_39_converted')).toMatchObject({ stage_role: 'converted', display_order: 904 })
    expect(res.board.config.stages.at(-1).slug).toBe('o_reset_39_converted')
  })

  it('removeStageWithDealsIs409', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const done = stageBySlug(board, 'o_reset_39_done')
    db.tables.deals.push({ id: 'd1', location_id: LOC, stage_id: done.id, status: 'lost' })
    const config = editableConfig(board, (c) => { c.stages = c.stages.filter((s) => s.role !== 'done') })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'stage_not_empty' })
    expect(db.tables.pipeline_stages.some((s) => s.id === done.id)).toBe(true)
  })

  it('removeStageWithLiveFollowupIs409', async () => {
    for (const state of ['draft', 'awaiting_approval', 'live']) {
      const db = seedDb()
      const board = await createdBoard(db)
      const done = stageBySlug(board, 'o_reset_39_done')
      db.tables.pipeline_stage_followups.push({ id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: done.id, pack_key: 'trial_done', state, version: 1 })
      const config = editableConfig(board, (c) => { c.stages = c.stages.filter((s) => s.role !== 'done') })
      const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
      expect(res).toMatchObject({ ok: false, status: 409, code: 'followup_active' })
      expect(db.calls.deletes).toHaveLength(0)
    }
  })

  it('removeEmptyStageDeletes', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const done = stageBySlug(board, 'o_reset_39_done')
    db.tables.pipeline_stage_followups.push({ id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: done.id, pack_key: 'trial_done', state: 'off', version: 1 })
    const config = editableConfig(board, (c) => { c.stages = c.stages.filter((s) => s.role !== 'done') })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(db.calls.deletes).toEqual([{ table: 'pipeline_stages', ids: [done.id] }])
    expect(stageBySlug(res.board, 'o_reset_39_done')).toBeUndefined()
    expect(res.board.config.stages.map((s) => s.role)).not.toContain('done')
  })

  it('badPatchConfigIs400WithIssues', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config: { entry: null } } })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'invalid_config' })
    expect(res.issues.length).toBeGreaterThan(0)
  })

  it('otherStudioBoardIs404', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    expect(await updateBoard(db, { locationId: OTHER, boardId: board.id, patch: { name: 'x' } })).toMatchObject({ ok: false, status: 404 })
    expect(await setBoardEnabled(db, { locationId: OTHER, boardId: board.id, enabled: true })).toMatchObject({ ok: false, status: 404 })
  })
})

describe('legacy boards', () => {
  it('legacyBoardIs409OnEveryWrite', async () => {
    const db = seedDb()
    const writes = [
      updateBoard(db, { locationId: LOC, boardId: 'legacy1', patch: { name: 'New name' } }),
      setBoardEnabled(db, { locationId: LOC, boardId: 'legacy1', enabled: false }),
      setBoardEnabled(db, { locationId: LOC, boardId: 'legacy1', enabled: true }),
    ]
    for (const res of await Promise.all(writes)) {
      expect(res).toMatchObject({ ok: false, status: 409, code: 'legacy_board', error: LEGACY_BOARD_ERROR })
    }
    expect(db.calls.updates).toHaveLength(0)
  })
})

describe('setBoardEnabled', () => {
  it('enableResetsBaseline', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const row = db.tables.pipelines.find((p) => p.id === board.id)
    row.baseline_at = '2026-11-01T00:00:00Z'
    const res = await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    expect(res.ok).toBe(true)
    expect(res.unchanged).toBeUndefined()
    expect(res.board).toMatchObject({ enabled: true, baseline_at: null })
    const writes = db.calls.updates.filter((u) => u.table === 'pipelines')
    expect(writes).toHaveLength(1)
    expect(writes[0].patch).toEqual({ enabled: true, baseline_at: null, updated_at: expect.any(String) })
    expect(writes[0].ids).toEqual([board.id])
  })

  it('enableTwiceUnchanged', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    const again = await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    expect(again).toMatchObject({ ok: true, unchanged: true, board: { enabled: true } })
    expect(db.calls.updates.filter((u) => u.table === 'pipelines')).toHaveLength(1)
  })

  it('disableIsACasToOff', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    const res = await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: false })
    expect(res).toMatchObject({ ok: true, board: { enabled: false } })
    expect(db.calls.updates.at(-1).patch).toEqual({ enabled: false, updated_at: expect.any(String) })
  })

  it('enableRefusesUn1tStudioAndBadConfig', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    db.tables.locations.find((l) => l.id === LOC).membership_source = 'un1t_online'
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'un1t_studio' })

    db.tables.locations.find((l) => l.id === LOC).membership_source = 'glofox'
    db.tables.pipelines.find((p) => p.id === board.id).config = { entry: null }
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'invalid_config' })
    expect(db.calls.updates).toHaveLength(0)
  })
})
