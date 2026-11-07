import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
const paidTrialIds = vi.hoisted(() => vi.fn())
vi.mock('./paid-trial-products.js', () => ({ paidTrialProductIdsFor: paidTrialIds }))

import {
  listBoards, getBoard, createBoard, updateBoard, setBoardEnabled, boardLocationId,
  SWITCH_OFF_FIRST_ERROR, LEGACY_BOARD_ERROR, STAGE_NAME_TAKEN_ERROR,
} from './pipeline-boards.js'
import { fakeDb, uniqueError } from './pipeline-boards.test-helpers.js'
import { stateFromBoard, settingsConfig, wizardReducer } from './pipeline-wizard.js'

beforeEach(() => { paidTrialIds.mockReset(); paidTrialIds.mockResolvedValue(new Set(['paid-trial'])) })

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
  pipelines: [{ id: 'legacy1', location_id: LOC, key: 'acquisition', name: 'Acquisition', board_type: null, mode: 'derived', enabled: true, is_primary: true, priority: 100, config: {}, display_order: 1 }],
  ...extra,
})

async function createdBoard(db, over = {}) {
  const res = await createBoard(db, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: clientConfig(), priority: 50, createdBy: 'u1', ...over })
  expect(res.ok).toBe(true)
  return res.board
}

const stageBySlug = (board, slug) => board.stages.find((s) => s.slug === slug)

describe('createBoard', () => {
  it('refusesThePaidTrialProduct', async () => {
    const db = seedDb('un1t_online')
    const config = clientConfig({ entry: { type: 'un1t_product', values: ['other', 'paid-trial'] } })
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'paid_trial_product' })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('aFailedPaidTrialReadIs503', async () => {
    paidTrialIds.mockRejectedValue(new Error('down'))
    const db = seedDb('un1t_online')
    const config = clientConfig({ entry: { type: 'un1t_product', values: ['prod-1'] } })
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config })
    expect(res).toMatchObject({ ok: false, status: 503, code: 'paid_trial_products_unreadable' })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('aNormalProductPasses', async () => {
    const db = seedDb('un1t_online')
    const config = clientConfig({ entry: { type: 'un1t_product', values: ['prod-1'] } })
    await createdBoard(db, { config })
    expect(db.calls.rpc).toHaveLength(1)
  })

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
    db.failures.create_configured_pipeline = [uniqueError('pipelines_location_key_unique')]
    const ok = await createdBoard(db)
    expect(db.calls.rpc.map((c) => c.args.p_key)).toEqual(['o_reset_39', 'o_reset_39_2'])
    expect(ok.key).toBe('o_reset_39_2')

    const db2 = seedDb()
    db2.failures.create_configured_pipeline = [uniqueError('pipelines_location_key_unique'), uniqueError('pipelines_location_key_unique')]
    const res = await createBoard(db2, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'key_taken' })
    expect(db2.calls.rpc).toHaveLength(2)
  })

  it('aStageSlugClashStillRetriesWithAFreshKey', async () => {
    const db = seedDb()
    // The constraint is named in details only: still recognised.
    db.failures.create_configured_pipeline = [{ code: '23505', message: 'duplicate key value', details: 'pipeline_stages_location_slug_unique' }]
    const ok = await createdBoard(db)
    expect(db.calls.rpc.map((c) => c.args.p_key)).toEqual(['o_reset_39', 'o_reset_39_2'])
    expect(ok.key).toBe('o_reset_39_2')
  })

  it('aStageNameClashIsStageNameTakenWithNoRetry', async () => {
    const db = seedDb()
    db.failures.create_configured_pipeline = [uniqueError('pipeline_stages_pipeline_name_unique')]
    const res = await createBoard(db, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'stage_name_taken', error: STAGE_NAME_TAKEN_ERROR })
    expect(db.calls.rpc).toHaveLength(1)
  })

  it('anUnknown23505IsAConflictWithNoRetry', async () => {
    const db = seedDb()
    db.failures.create_configured_pipeline = [{ code: '23505', message: 'duplicate key value violates unique constraint "something_else"' }]
    const res = await createBoard(db, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'conflict' })
    expect(db.calls.rpc).toHaveLength(1)
  })

  it('repeatedStageNamesAre400BeforeTheRpc', async () => {
    const db = seedDb()
    const config = clientConfig()
    config.stages[3].name = 'day 7'
    const res = await createBoard(db, { locationId: LOC, name: 'Reset 39', recipeKey: 'paid_trial_offer', config })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'invalid_config' })
    expect(res.issues).toContainEqual({ path: 'config', message: 'stages[3] repeats the name day 7' })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('createsOfferUn1tAtUn1tStudio', async () => {
    const db = seedDb('un1t_online')
    const config = clientConfig({ entry: { type: 'un1t_product', values: ['prod-39'] } })
    const board = await createdBoard(db, { config })
    expect(db.calls.rpc).toHaveLength(1)
    expect(db.calls.rpc[0].args).toMatchObject({ p_board_type: 'offer', p_module: 'offer_un1t' })
    expect(board).toMatchObject({ enabled: false })
  })

  it('refusesLeadSourceAtUn1tStudio', async () => {
    const db = seedDb('un1t_online')
    const config = clientConfig({ entry: { type: 'lead_source', values: ['meta'] } })
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'invalid_config' })
    expect(res.issues[0].message).toMatch(/does not work at this studio/)
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('refusesUn1tProductAtGlofoxStudio', async () => {
    const db = seedDb('glofox')
    const config = clientConfig({ entry: { type: 'un1t_product', values: ['prod-39'] } })
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'invalid_config' })
    expect(db.calls.rpc).toHaveLength(0)
  })

  it('unreadableMembershipSourceIs503', async () => {
    const db = seedDb()
    db.failures['locations:select'] = { message: 'down' }
    const res = await createBoard(db, { locationId: LOC, name: 'Reset', recipeKey: 'paid_trial_offer', config: clientConfig() })
    expect(res).toMatchObject({ ok: false, status: 503, code: 'membership_source_unreadable' })
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
    expect(offer.followups).toEqual([{ id: 'f1', stage_id: newStage.id, pack_key: 'book_first_class', state: 'live', want_live: true, version: 1, sequence_id: 's1', whatsapp_template_id: 't1', health: null }])
    expect(offer.health_unread).toBeUndefined()
  })

  it('getBoardIs404AtAnotherStudio', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    expect(await getBoard(db, OTHER, board.id)).toMatchObject({ ok: false, status: 404 })
    expect(await boardLocationId(db, board.id)).toEqual({ ok: true, locationId: LOC })
    expect(await boardLocationId(db, 'nope')).toMatchObject({ ok: false, status: 404 })
  })

  it('getBoardCarriesEachFollowupsCurrentWordingFromItsTemplates', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const day7 = stageBySlug(board, 'o_reset_39_day_7')
    const newStage = stageBySlug(board, 'o_reset_39_new')
    const body = (text) => [{ type: 'BODY', text }, { type: 'FOOTER', text: 'Reply STOP to unsubscribe' }]
    db.tables.whatsapp_templates = [
      { id: 't1', location_id: LOC, name: 'un1t_stillorgan_o_reset_39_halfway_main_v2', status: 'APPROVED', components: body('Hi {{1}}, halfway. Karl') },
      { id: 't2', location_id: LOC, name: 'un1t_stillorgan_o_reset_39_halfway_nudge_v2', status: 'APPROVED', components: body('Hi {{1}}, book a class. Karl') },
      // Same name at another studio: never read.
      { id: 't3', location_id: OTHER, name: 'un1t_stillorgan_o_reset_39_book_first_class_main', status: 'APPROVED', components: body('Hi {{1}}, other studio.') },
      { id: 't4', location_id: LOC, name: 'un1t_stillorgan_o_reset_39_halfway_nudge', status: 'APPROVED', components: body('Hi {{1}}, the old v1 nudge.') },
    ]
    db.tables.pipeline_stage_followups.push(
      { id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: day7.id, pack_key: 'halfway', state: 'live', want_live: true, version: 2, sequence_id: 's1', whatsapp_template_id: 't1' },
      { id: 'f2', location_id: LOC, pipeline_id: board.id, stage_id: newStage.id, pack_key: 'book_first_class', state: 'live', want_live: true, version: 1, sequence_id: 's2', whatsapp_template_id: 't3' },
    )
    const res = await getBoard(db, LOC, board.id)
    expect(res.ok).toBe(true)
    const f1 = res.board.followups.find((f) => f.id === 'f1')
    expect(f1.body_text).toBe('Hi {{1}}, halfway. Karl')
    expect(f1.body_texts).toEqual({ main: 'Hi {{1}}, halfway. Karl', nudge: 'Hi {{1}}, book a class. Karl' })
    expect(f1.wording_missing).toBeUndefined()
    const f2 = res.board.followups.find((f) => f.id === 'f2')
    expect(f2.body_text).toBeUndefined()
    expect(f2.wording_missing).toEqual(['main'])
    expect(res.board.wording_unread).toBeUndefined()
  })

  it('aSecondMessageNotFoundIsWordingMissing', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const day7 = stageBySlug(board, 'o_reset_39_day_7')
    db.tables.whatsapp_templates = [
      { id: 't1', location_id: LOC, name: 'renamed_template', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hi {{1}}, halfway.' }] },
    ]
    db.tables.pipeline_stage_followups.push({ id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: day7.id, pack_key: 'halfway', state: 'live', want_live: true, version: 1, sequence_id: 's1', whatsapp_template_id: 't1' })
    const res = await getBoard(db, LOC, board.id)
    const f1 = res.board.followups[0]
    expect(f1.body_texts).toEqual({ main: 'Hi {{1}}, halfway.' })
    expect(f1.wording_missing).toEqual(['nudge'])
  })

  it('aRenameOnALiveBoardSavesWithTheSettingsPagesConfig', async () => {
    const db = seedDb()
    await createdBoard(db)
    const created = (await listBoards(db, LOC)).boards.find((b) => b.key === 'o_reset_39')
    await setBoardEnabled(db, { locationId: LOC, boardId: created.id, enabled: true })
    const board = (await getBoard(db, LOC, created.id)).board
    expect(board.enabled).toBe(true)
    let state = stateFromBoard(board, board.recipe_key, { studioName: 'UN1T Stillorgan' })
    const i = state.stages.findIndex((st) => st.role === 'first_class' && st.enabled)
    state = wizardReducer(state, { type: 'renameStage', index: i, name: 'First session' })
    const config = settingsConfig(state, board.config)
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(res.board.stages.find((st) => st.stage_role === 'first_class').name).toBe('First session')
    expect(res.board.config).toEqual({ ...board.config, stages: board.config.stages.map((st) => (st.role === 'first_class' ? { ...st, name: 'First session' } : st)) })
  })

  it('anUnreadableTemplateLeavesTheWordingOutAndNeverFailsTheRead', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const newStage = stageBySlug(board, 'o_reset_39_new')
    db.tables.pipeline_stage_followups.push({ id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: newStage.id, pack_key: 'book_first_class', state: 'live', want_live: true, version: 1, sequence_id: 's1', whatsapp_template_id: 't1' })
    db.failures['whatsapp_templates:select'] = { message: 'down' }
    const res = await getBoard(db, LOC, board.id)
    expect(res.ok).toBe(true)
    expect(res.board.wording_unread).toBe(true)
    expect(res.board.followups[0].body_text).toBeUndefined()
  })

  // RAILS.3 — a follow-up's health: WhatsApp paused or rejected its template,
  // or its sequence is paused. Derived at read time, never stored.
  describe('follow-up health', () => {
    async function boardWithRows(rows, { templates = [], sequences = [] } = {}) {
      const db = seedDb()
      const board = await createdBoard(db)
      const stages = ['o_reset_39_new', 'o_reset_39_first_class', 'o_reset_39_day_7', 'o_reset_39_done'].map((sl) => stageBySlug(board, sl))
      db.tables.whatsapp_templates = templates.map((t) => ({ location_id: LOC, name: `n_${t.id}`, components: [], ...t }))
      db.tables.email_sequences = sequences.map((q) => ({ location_id: LOC, ...q }))
      rows.forEach((r, i) => db.tables.pipeline_stage_followups.push({
        location_id: LOC, pipeline_id: board.id, stage_id: stages[i].id, pack_key: 'book_first_class', want_live: true, version: 1, ...r,
      }))
      return { db, board }
    }
    const healthOf = (b, id) => b.followups.find((f) => f.id === id).health

    it('derivesEachHealthFromTheTemplateAndSequence', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'live', sequence_id: 'q1', whatsapp_template_id: 't1' },
        { id: 'f2', state: 'live', sequence_id: 'q2', whatsapp_template_id: 't2' },
        { id: 'f3', state: 'live', sequence_id: 'q3', whatsapp_template_id: 't3' },
        { id: 'f4', state: 'live', sequence_id: 'q4', whatsapp_template_id: 't4' },
      ], {
        templates: [{ id: 't1', status: 'PAUSED' }, { id: 't2', status: 'DISABLED' }, { id: 't3', status: 'APPROVED' }, { id: 't4', status: 'APPROVED' }],
        sequences: [{ id: 'q1', status: 'active' }, { id: 'q2', status: 'paused' }, { id: 'q3', status: 'paused' }, { id: 'q4', status: 'active' }],
      })
      const res = await getBoard(db, LOC, board.id)
      expect(res.ok).toBe(true)
      expect(healthOf(res.board, 'f1')).toBe('template_paused')
      expect(healthOf(res.board, 'f2')).toBe('template_rejected')   // template beats the paused sequence
      expect(healthOf(res.board, 'f3')).toBe('sequence_paused')
      expect(healthOf(res.board, 'f4')).toBeNull()
      expect(res.board.health_unread).toBeUndefined()
    })

    it('rejectedWhileAwaitingApprovalButAPausedSequenceIsOnlyALiveRowsHealth', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'awaiting_approval', sequence_id: 'q1', whatsapp_template_id: 't1' },
        { id: 'f2', state: 'awaiting_approval', sequence_id: 'q2', whatsapp_template_id: 't2' },
        { id: 'f3', state: 'off', sequence_id: 'q3', whatsapp_template_id: 't3' },
      ], {
        templates: [{ id: 't1', status: 'REJECTED' }, { id: 't2', status: 'PENDING' }, { id: 't3', status: 'PAUSED' }],
        sequences: [{ id: 'q1', status: 'draft' }, { id: 'q2', status: 'paused' }, { id: 'q3', status: 'paused' }],
      })
      const res = await getBoard(db, LOC, board.id)
      expect(healthOf(res.board, 'f1')).toBe('template_rejected')
      expect(healthOf(res.board, 'f2')).toBeNull()
      expect(healthOf(res.board, 'f3')).toBeNull()        // an off row is already truthful
    })

    it('readsOnlyThisStudiosTemplatesAndSequences', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'live', sequence_id: 'q1', whatsapp_template_id: 't1' },
      ], {
        templates: [{ id: 't1', location_id: OTHER, status: 'PAUSED' }],
        sequences: [{ id: 'q1', location_id: OTHER, status: 'paused' }],
      })
      const res = await getBoard(db, LOC, board.id)
      expect(healthOf(res.board, 'f1')).toBeNull()
    })

    it('aFailedTemplateReadIsHealthUnreadAndKeepsTheBoard', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'live', sequence_id: 'q1', whatsapp_template_id: 't1' },
      ], { templates: [{ id: 't1', status: 'PAUSED' }], sequences: [{ id: 'q1', status: 'paused' }] })
      db.failures['whatsapp_templates:select'] = { message: 'down' }
      const res = await getBoard(db, LOC, board.id)
      expect(res.ok).toBe(true)
      expect(res.board.health_unread).toBe(true)
      expect(res.board.followups[0]).toMatchObject({ id: 'f1', state: 'live', health: null })
      expect(res.board.stages).toHaveLength(4)

      const listed = await listBoards(db, LOC)
      expect(listed.ok).toBe(true)
      const offer = listed.boards.find((b) => b.id === board.id)
      expect(offer.health_unread).toBe(true)
      expect(offer.followups[0].health).toBeNull()
    })

    it('aFailedSequenceReadIsHealthUnread', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'live', sequence_id: 'q1', whatsapp_template_id: 't1' },
      ], { templates: [{ id: 't1', status: 'PAUSED' }], sequences: [{ id: 'q1', status: 'active' }] })
      db.failures['email_sequences:select'] = { message: 'down' }
      const res = await getBoard(db, LOC, board.id)
      expect(res.ok).toBe(true)
      expect(res.board.health_unread).toBe(true)
      expect(res.board.followups[0].health).toBeNull()
    })

    it('listBoardsCarriesTheSameHealth', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'live', sequence_id: 'q1', whatsapp_template_id: 't1' },
      ], { templates: [{ id: 't1', status: 'PAUSED' }], sequences: [{ id: 'q1', status: 'active' }] })
      const res = await listBoards(db, LOC)
      const offer = res.boards.find((b) => b.id === board.id)
      expect(offer.followups[0].health).toBe('template_paused')
      expect(res.boards.find((b) => b.key === 'acquisition').health_unread).toBeUndefined()
    })

    it('aReinstatedTemplateIsHealthyAgainWithNoWrite', async () => {
      const { db, board } = await boardWithRows([
        { id: 'f1', state: 'live', sequence_id: 'q1', whatsapp_template_id: 't1' },
      ], { templates: [{ id: 't1', status: 'PAUSED' }], sequences: [{ id: 'q1', status: 'active' }] })
      expect(healthOf((await getBoard(db, LOC, board.id)).board, 'f1')).toBe('template_paused')
      db.tables.whatsapp_templates[0].status = 'APPROVED'   // the webhook stores REINSTATED as APPROVED
      expect(healthOf((await getBoard(db, LOC, board.id)).board, 'f1')).toBeNull()
      expect(db.calls.updates.filter((u) => u.table === 'pipeline_stage_followups')).toHaveLength(0)
    })
  })

  // RAILS.4 — a held first placement says so.
  describe('baseline pending', () => {
    const SWITCHED = '2026-11-06T12:00:00.000Z'
    async function pendingBoard(runs = []) {
      const db = seedDb()
      const created = await createdBoard(db)
      const row = db.tables.pipelines.find((p) => p.id === created.id)
      Object.assign(row, { enabled: true, baseline_at: null, updated_at: SWITCHED })
      db.tables.pipeline_classification_runs = runs.map((r) => ({
        location_id: LOC, dry_run: false, status: 'success', errors: 0, error_message: null, finished_at: null, ...r,
      }))
      return { db, id: created.id }
    }
    const pendingOf = async (db, id) => (await getBoard(db, LOC, id)).board.baseline_pending

    it('aFailedRunAfterSwitchOnHoldsTheBoardWithItsCounts', async () => {
      const { db, id } = await pendingBoard([
        { started_at: '2026-11-07T03:30:00.000Z', finished_at: '2026-11-07T03:31:00.000Z', status: 'partial', errors: 3 },
        { started_at: '2026-11-05T03:30:00.000Z', status: 'success', errors: 0 },
        { started_at: '2026-11-07T09:00:00.000Z', status: 'success', errors: 0, dry_run: true },   // a dry run never counts
        { started_at: '2026-11-07T10:00:00.000Z', status: 'success', errors: 0, location_id: OTHER },
      ])
      expect(await pendingOf(db, id)).toEqual({
        cadence: 'nightly',
        last_run: { status: 'partial', errors: 3, started_at: '2026-11-07T03:30:00.000Z', finished_at: '2026-11-07T03:31:00.000Z' },
        held: true,
      })
      const listed = (await listBoards(db, LOC)).boards
      expect(listed.find((b) => b.id === id).baseline_pending.held).toBe(true)
      expect(listed.find((b) => b.key === 'acquisition').baseline_pending).toBeUndefined()
    })

    it('aCleanRunIsNotHeld', async () => {
      const { db, id } = await pendingBoard([{ started_at: '2026-11-07T03:30:00.000Z', status: 'success', errors: 0 }])
      expect((await pendingOf(db, id)).held).toBe(false)
    })

    it('aFailedRunFromBeforeSwitchOnIsNotHeld', async () => {
      const { db, id } = await pendingBoard([{ started_at: '2026-11-06T03:30:00.000Z', status: 'failed', errors: 9 }])
      const pending = await pendingOf(db, id)
      expect(pending.held).toBe(false)
      expect(pending.last_run.status).toBe('failed')
    })

    it('aRunningRunAfterSwitchOnIsPendingNotHeld', async () => {
      const { db, id } = await pendingBoard([{ started_at: '2026-11-07T03:30:00.000Z', status: 'running', errors: 0 }])
      const pending = await pendingOf(db, id)
      expect(pending.held).toBe(false)
      expect(pending.last_run.status).toBe('running')
    })

    it('aCleanCountWithAnExclusionFailureIsHeld', async () => {
      const { db, id } = await pendingBoard([{ started_at: '2026-11-07T03:30:00.000Z', status: 'success', errors: 0, error_message: 'other-studio members unavailable: x' }])
      const pending = await pendingOf(db, id)
      expect(pending.held).toBe(true)
      expect(pending.last_run).toEqual({ status: 'success', errors: 0, started_at: '2026-11-07T03:30:00.000Z', finished_at: null })
    })

    it('noRunIsLastRunNull', async () => {
      const { db, id } = await pendingBoard([])
      expect(await pendingOf(db, id)).toEqual({ cadence: 'nightly', last_run: null, held: false })
    })

    it('aUn1tOnlineBoardIsPlacedHourly', async () => {
      const { db, id } = await pendingBoard([])
      db.tables.pipelines.find((p) => p.id === id).module = 'offer_un1t'
      expect((await pendingOf(db, id)).cadence).toBe('hourly')
    })

    it('aFailedRunsReadIsUnreadAndKeepsTheBoard', async () => {
      const { db, id } = await pendingBoard([{ started_at: '2026-11-07T03:30:00.000Z', status: 'failed', errors: 2 }])
      db.failures['pipeline_classification_runs:select'] = { message: 'down' }
      const res = await getBoard(db, LOC, id)
      expect(res.ok).toBe(true)
      expect(res.board.baseline_pending).toEqual({ cadence: 'nightly', last_run: null, held: false, unread: true })
    })

    it('aBaselinedOrOffBoardCarriesNoBaselinePendingAndReadsNoRuns', async () => {
      const { db, id } = await pendingBoard([{ started_at: '2026-11-07T03:30:00.000Z', status: 'failed', errors: 2 }])
      const row = db.tables.pipelines.find((p) => p.id === id)
      row.baseline_at = '2026-11-07T03:31:00.000Z'
      expect((await getBoard(db, LOC, id)).board.baseline_pending).toBeUndefined()
      row.baseline_at = null
      row.enabled = false
      db.failures['pipeline_classification_runs:select'] = { message: 'down' }
      const res = await getBoard(db, LOC, id)
      expect(res.board.baseline_pending).toBeUndefined()
    })
  })

  it('unreadableDealsIs503NotZero', async () => {
    const db = seedDb()
    await createdBoard(db)
    db.failures['deals:select'] = { message: 'down' }
    expect(await listBoards(db, LOC)).toMatchObject({ ok: false, status: 503 })
  })
})

describe('updateBoard', () => {
  it('refusesThePaidTrialProductAndUnreadableCheck', async () => {
    const db = seedDb('un1t_online')
    const board = await createdBoard(db, { config: clientConfig({ entry: { type: 'un1t_product', values: ['prod-1'] } }) })
    const cfg = structuredClone(board.config)
    cfg.entry.values = ['paid-trial']
    const before = db.calls.updates.length
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config: cfg } })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'paid_trial_product' })
    paidTrialIds.mockRejectedValue(new Error('down'))
    const res2 = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config: cfg } })
    expect(res2).toMatchObject({ ok: false, status: 503, code: 'paid_trial_products_unreadable' })
    expect(db.calls.updates).toHaveLength(before)
    paidTrialIds.mockResolvedValue(new Set(['paid-trial']))
    cfg.entry.values = ['prod-2']
    expect((await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config: cfg } })).ok).toBe(true)
  })

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

  const ordersOf = (db, boardId) => db.tables.pipeline_stages
    .filter((s) => s.pipeline_id === boardId)
    .map((s) => [s.slug, s.display_order])

  it('insertingAStageMidListRenumbersEveryColumn', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const config = editableConfig(board, (c) => {
      const at = c.stages.findIndex((s) => s.role === 'checkpoint')
      c.stages.splice(at, 0, { role: 'checkpoint', name: 'Day 3', day: 3 })
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    const wantOrder = ['o_reset_39_new', 'o_reset_39_first_class', 'o_reset_39_day_3', 'o_reset_39_day_7', 'o_reset_39_done']
    expect(res.board.config.stages.map((s) => s.slug)).toEqual(wantOrder)
    const orders = new Map(ordersOf(db, board.id))
    wantOrder.forEach((slug, i) => expect(orders.get(slug)).toBe(900 + i))
    expect(new Set(orders.values()).size).toBe(orders.size)
    expect(res.board.stages.map((s) => s.slug)).toEqual(wantOrder)
  })

  it('reorderingKeptStagesMovesTheirColumns', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const config = editableConfig(board, (c) => { c.stages.reverse() })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    const orders = new Map(ordersOf(db, board.id))
    config.stages.forEach((s, i) => expect(orders.get(`o_reset_39_${s.role === 'checkpoint' ? 'day_7' : s.role}`)).toBe(900 + i))
    expect(new Set(orders.values()).size).toBe(orders.size)
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

  it('changingACheckpointDayKeepsItsNameAndWorks', async () => {
    // Day 7 → Day 10 under the same name: a new slug, the old stage removed.
    const db = seedDb()
    const board = await createdBoard(db)
    const oldDay = stageBySlug(board, 'o_reset_39_day_7')
    const config = editableConfig(board, (c) => {
      const cp = c.stages.find((s) => s.role === 'checkpoint')
      cp.day = 10
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(stageBySlug(res.board, 'o_reset_39_day_7')).toBeUndefined()
    expect(stageBySlug(res.board, 'o_reset_39_day_10')).toMatchObject({ name: 'Day 7', role_config: { day: 10 }, display_order: 902 })
    expect(db.tables.pipeline_stages.some((s) => s.id === oldDay.id)).toBe(false)
    // The fake enforces UNIQUE (pipeline_id, name), so the insert of a second
    // "Day 7" could only land because the old one was deleted first.
    expect(db.calls.deletes).toEqual([{ table: 'pipeline_stages', ids: [oldDay.id] }])
  })

  it('swappingTwoStageNamesWorks', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'new').name = 'Done'
      c.stages.find((s) => s.role === 'done').name = 'New'
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(stageBySlug(res.board, 'o_reset_39_new').name).toBe('Done')
    expect(stageBySlug(res.board, 'o_reset_39_done').name).toBe('New')
    expect(db.tables.pipeline_stages.some((s) => String(s.name).startsWith('__tmp_'))).toBe(false)
    // Each renamed stage parked on its temporary name first.
    const parks = db.calls.updates.filter((u) => u.table === 'pipeline_stages' && String(u.patch.name || '').startsWith('__tmp_'))
    expect(parks).toHaveLength(2)
  })

  it('aNewStageMayTakeARenamedStagesOldName', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'done').name = 'Trial over'
      c.stages.push({ role: 'converted', name: 'Done' })
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(stageBySlug(res.board, 'o_reset_39_done').name).toBe('Trial over')
    expect(stageBySlug(res.board, 'o_reset_39_converted').name).toBe('Done')
  })

  it('aStageNameClashFromTheDatabaseIs409StageNameTakenAndUnparks', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    // An archived stage row on this board still holds a name (not in the config).
    db.tables.pipeline_stages.push({ id: 'arch1', pipeline_id: board.id, location_id: LOC, slug: 'o_reset_39_old', name: 'Kept name', archived: true })
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'done').name = 'Trial over'
      c.stages.push({ role: 'converted', name: 'Kept name' })
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'stage_name_taken', error: STAGE_NAME_TAKEN_ERROR })
    // The parked stage went back to its old name.
    expect(db.tables.pipeline_stages.find((s) => s.slug === 'o_reset_39_done').name).toBe('Done')
  })

  it('anOrphanRowHoldingAFinalNameIsRefusedBeforeAnyWrite', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    db.tables.pipeline_stages.push({ id: 'orph1', pipeline_id: board.id, location_id: LOC, slug: 'o_reset_39_orphan', name: '  kept NAME ', archived: false })
    const writes = () => db.calls.updates.length + db.calls.inserts.length + db.calls.deletes.length
    const before = writes()
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'done').name = 'Trial over'
      c.stages.push({ role: 'converted', name: 'Kept name' })
    })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'stage_name_taken', error: STAGE_NAME_TAKEN_ERROR })
    expect(writes()).toBe(before)
  })

  it('aMidSwapFailureInTheFinalRenamesLeavesNoTempName', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'new').name = 'Done'
      c.stages.find((s) => s.role === 'done').name = 'New'
    })
    // Fail the SECOND final rename (the first has already landed).
    const realFrom = db.from.bind(db)
    let finals = 0
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'pipeline_stages') return b
      const realUpdate = b.update
      b.update = (patch) => {
        if (patch.name && !String(patch.name).startsWith('__tmp_') && ['Done', 'New'].includes(patch.name) && patch.display_order === undefined) {
          finals += 1
          if (finals === 1) {
            // let the first final through
            return realUpdate(patch)
          }
          if (finals === 2) {
            const failing = realUpdate({})
            failing.then = (resolve) => Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } }).then(resolve)
            return failing
          }
        }
        return realUpdate(patch)
      }
      return b
    }
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(false)
    expect(finals).toBeGreaterThanOrEqual(2)
    expect(db.tables.pipeline_stages.some((s) => String(s.name).startsWith('__tmp_'))).toBe(false)
    expect(db.tables.pipeline_stages.find((s) => s.slug === 'o_reset_39_new').name).toBe('New')
    expect(db.tables.pipeline_stages.find((s) => s.slug === 'o_reset_39_done').name).toBe('Done')
  })

  it('aFailedFinalWriteDeletesTheInsertedRowSoARenamedStageGoesHome', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const done = stageBySlug(board, 'o_reset_39_done')
    const config = editableConfig(board, (c) => {
      c.stages.find((s) => s.role === 'done').name = 'Trial over'
      c.stages.push({ role: 'converted', name: 'Done' })
    })
    // Fail the step-6 write of the renamed stage ('Trial over').
    const realFrom = db.from.bind(db)
    db.from = (table) => {
      const b = realFrom(table)
      if (table !== 'pipeline_stages') return b
      const realUpdate = b.update
      b.update = (patch) => {
        if (patch.name === 'Trial over') {
          const failing = realUpdate({})
          failing.then = (resolve) => Promise.resolve({ data: null, error: { code: 'XX000', message: 'boom' } }).then(resolve)
          return failing
        }
        return realUpdate(patch)
      }
      return b
    }
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(false)
    expect(db.tables.pipeline_stages.some((s) => String(s.name).startsWith('__tmp_'))).toBe(false)
    expect(db.tables.pipeline_stages.find((s) => s.id === done.id).name).toBe('Done')
    expect(db.tables.pipeline_stages.some((s) => s.slug === 'o_reset_39_converted')).toBe(false)
  })

  it('removingAStageArchivesItsFollowupSequencesFirst', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const done = stageBySlug(board, 'o_reset_39_done')
    db.tables.pipeline_stage_followups.push(
      { id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: done.id, pack_key: 'trial_done', state: 'off', version: 2, sequence_id: 'seq-old' },
      { id: 'f2', location_id: LOC, pipeline_id: board.id, stage_id: done.id, pack_key: 'trial_done_2', state: 'rejected', version: 1, sequence_id: 'seq-draft' },
    )
    db.tables.email_sequences = [
      { id: 'seq-old', location_id: LOC, status: 'paused' },
      { id: 'seq-draft', location_id: LOC, status: 'draft' },
      { id: 'seq-live-elsewhere', location_id: LOC, status: 'active' },
    ]
    const config = editableConfig(board, (c) => { c.stages = c.stages.filter((s) => s.role !== 'done') })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(db.tables.email_sequences.map((q) => [q.id, q.status])).toEqual([
      ['seq-old', 'archived'], ['seq-draft', 'archived'], ['seq-live-elsewhere', 'active'],
    ])
    const archives = db.calls.updates.filter((u) => u.table === 'email_sequences')
    expect(archives.every((u) => u.patch.status === 'archived')).toBe(true)
    expect(db.calls.deletes).toEqual([{ table: 'pipeline_stages', ids: [done.id] }])
  })

  it('aFailedFollowupArchiveDoesNotStopTheStageRemoval', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    const done = stageBySlug(board, 'o_reset_39_done')
    db.tables.pipeline_stage_followups.push({ id: 'f1', location_id: LOC, pipeline_id: board.id, stage_id: done.id, pack_key: 'trial_done', state: 'off', version: 1, sequence_id: 'seq-old' })
    db.failures['email_sequences:update'] = { message: 'down' }
    const config = editableConfig(board, (c) => { c.stages = c.stages.filter((s) => s.role !== 'done') })
    const res = await updateBoard(db, { locationId: LOC, boardId: board.id, patch: { config } })
    expect(res.ok).toBe(true)
    expect(stageBySlug(res.board, 'o_reset_39_done')).toBeUndefined()
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

  it('enableRefusesModuleMismatch', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    db.tables.locations.find((l) => l.id === LOC).membership_source = 'un1t_online'
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'module_mismatch' })
  })

  it('enablesOfferUn1tAtUn1tStudio', async () => {
    const db = seedDb('un1t_online')
    const board = await createdBoard(db, { config: clientConfig({ entry: { type: 'un1t_product', values: ['prod-39'] } }) })
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: true, board: { enabled: true } })
  })

  it('enableRefusesOfferUn1tAtGlofoxStudio', async () => {
    const db = seedDb('glofox')
    const board = await createdBoard(db)
    db.tables.pipelines.find((p) => p.id === board.id).module = 'offer_un1t'
    db.tables.pipelines.find((p) => p.id === board.id).config = { ...clientConfig(), entry: { type: 'un1t_product', values: ['prod-39'] }, stages: db.tables.pipelines.find((p) => p.id === board.id).config.stages }
    const before = db.calls.updates.length
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'module_mismatch' })
    expect(db.calls.updates).toHaveLength(before)
  })

  it('enableRefusesBadConfig', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    db.tables.pipelines.find((p) => p.id === board.id).config = { entry: null }
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'invalid_config' })
    expect(db.calls.updates).toHaveLength(0)
  })

  // AUDIT.1 — an offer board switches on only beside an enabled derived primary
  // board: the router files everyone without a live claim on it, and every
  // event path places from it.
  it('enableRefusesWithoutPrimaryBoard', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    db.tables.pipelines.find((p) => p.id === 'legacy1').enabled = false
    const before = db.calls.updates.length
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'no_primary_board', error: expect.stringContaining('Acquisition board first') })
    expect(db.calls.updates).toHaveLength(before)
  })

  it('enableRefusesBesideAManualPrimaryBoard', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    db.tables.pipelines.find((p) => p.id === 'legacy1').mode = 'manual'
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true }))
      .toMatchObject({ ok: false, status: 409, code: 'no_primary_board' })
  })

  it('disableNeedsNoPrimaryBoard', async () => {
    const db = seedDb()
    const board = await createdBoard(db)
    await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: true })
    db.tables.pipelines.find((p) => p.id === 'legacy1').enabled = false
    expect(await setBoardEnabled(db, { locationId: LOC, boardId: board.id, enabled: false }))
      .toMatchObject({ ok: true, board: { enabled: false } })
  })
})
