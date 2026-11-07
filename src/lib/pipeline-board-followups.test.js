import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/pipeline-followup-packs', () => ({ installFollowupPack: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { applyFollowupAction, renderInputsFor, packForStage } from './pipeline-board-followups'
import { installFollowupPack } from '@/lib/pipeline-followup-packs'
import { logError } from '@/lib/log'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const BOARD_ID = 'b0000000-0000-4000-8000-000000000001'
const STAGE_ID = 'c0000000-0000-4000-8000-000000000001'

const board = (over = {}) => ({
  id: BOARD_ID,
  key: 'o_reset',
  name: 'Reset',
  board_type: 'offer',
  recipe_key: 'paid_trial_offer',
  config: { offer_name: '14 Day Reset', signer: 'Alex Example', duration_days: 14 },
  stages: [{ id: STAGE_ID, slug: 'o_reset_new', name: 'New Leads', stage_role: 'new' }],
  ...over,
})
const stage = { id: STAGE_ID, slug: 'o_reset_new', name: 'New Leads', stage_role: 'new' }
const user = { id: 'user-1' }

const SETTINGS = {
  whatsapp_flow: { enabled: true, flow_id: 'flow-123', invite_text: 'secret-ish copy' },
  un1t_online: { api_token: 'tok_should_never_leak', app_links: { ios_url: 'https://apps.apple.com/x', android_url: 'https://play.google.com/y', heading: 'H' } },
  xero: { client_secret: 'never' },
}

// A recording fake. Every awaited builder is logged in order as
// { table, op, values, filters, select }, then answered by `respond(entry)`.
function makeDb(respond) {
  const log = []
  return {
    log,
    from(table) {
      const entry = { table, op: 'select', values: null, filters: {}, select: null }
      const q = {
        select(cols) { if (entry.op === 'select') entry.select = cols; else entry.select = cols; return q },
        insert(v) { entry.op = 'insert'; entry.values = v; return q },
        update(v) { entry.op = 'update'; entry.values = v; return q },
        delete() { entry.op = 'delete'; return q },
        eq(c, v) { entry.filters[c] = v; return q },
        in(c, v) { entry.filters[c] = v; return q },
        is(c, v) { entry.filters[c] = v; return q },
        order() { return q },
        range() { return q },
        maybeSingle() { entry.single = true; return q },
        single() { entry.single = true; return q },
        then(resolve, reject) {
          log.push(entry)
          return Promise.resolve(respond(entry)).then(resolve, reject)
        },
      }
      return q
    },
  }
}

const locationRow = { data: { name: 'UN1T Hatch Street', settings: SETTINGS }, error: null }

// Default answers: the studio, the follow-up row (or none), and a write that touched one row.
function responder({ row = null, overrides = {} } = {}) {
  return (e) => {
    for (const [key, fn] of Object.entries(overrides)) {
      const [table, op] = key.split(':')
      if (e.table === table && e.op === op) {
        const r = fn(e)
        if (r !== undefined) return r
      }
    }
    if (e.table === 'locations') return locationRow
    if (e.table === 'pipeline_stage_followups' && e.op === 'select') return { data: row, error: null }
    if (e.op === 'update' || e.op === 'delete') return { data: [{ id: e.filters.id }], error: null }
    return { data: null, error: null }
  }
}

const liveRow = (over = {}) => ({
  id: 'f1', location_id: LOC, pipeline_id: BOARD_ID, stage_id: STAGE_ID, sequence_id: 's1',
  whatsapp_template_id: 't1', pack_key: 'book_first_class', version: 1, state: 'live', want_live: true,
  created_by: 'user-0', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z', ...over,
})

// The row's old sequence is a draft: the pause CAS misses, the re-read says draft.
const draftSequence = {
  'email_sequences:update': () => ({ data: [], error: null }),
  'email_sequences:select': () => ({ data: { id: 's1', status: 'draft' }, error: null }),
}

let db
beforeEach(() => {
  vi.clearAllMocks()
  installFollowupPack.mockImplementation(async (_db, opts) => {
    db.log.push({ table: 'installFollowupPack', op: 'call', values: opts })
    return { ok: true, followup: { id: 'f-new', state: 'awaiting_approval', version: opts.version }, created: true }
  })
})

const run = (over) => applyFollowupAction(db, {
  user, board: board(), stage, action: 'install', packKey: 'book_first_class', locationId: LOC, ...over,
})
const writes = () => db.log.filter((e) => e.op !== 'select').map((e) => `${e.table}:${e.op}`)

describe('renderInputsFor', () => {
  it('renderInputsNeverReturnSettings', async () => {
    db = makeDb(responder())
    const res = await renderInputsFor(db, board(), LOC)
    expect(res).toEqual({
      ok: true,
      render: {
        studioName: 'UN1T Hatch Street',
        offerName: '14 Day Reset',
        durationDays: 14,
        signer: 'Alex Example',
        bookingFlowId: 'flow-123',
        appLinks: { iosUrl: 'https://apps.apple.com/x', androidUrl: 'https://play.google.com/y' },
      },
    })
    expect(JSON.stringify(res)).not.toMatch(/tok_should_never_leak|client_secret|secret-ish|"settings"/)
    const read = db.log.find((e) => e.table === 'locations')
    expect(read.select).toBe('name, settings')
    expect(read.filters).toEqual({ id: LOC })
  })

  it('fallsBackToBoardNameAndStudioAndLeavesOutAFlowThatIsOffAndOneAppLink', async () => {
    db = makeDb(responder({ overrides: {
      'locations:select': () => ({ data: { name: 'UN1T Stillorgan', settings: {
        whatsapp_flow: { enabled: false, flow_id: 'flow-9' },
        un1t_online: { app_links: { ios_url: 'https://apps.apple.com/x' } },
      } }, error: null }),
    } }))
    const res = await renderInputsFor(db, board({ config: { duration_days: '7' } }), LOC)
    expect(res.render).toEqual({ studioName: 'UN1T Stillorgan', offerName: 'Reset', durationDays: 7, signer: 'UN1T Stillorgan' })
  })

  it('aFailedStudioReadIs503', async () => {
    db = makeDb(responder({ overrides: { 'locations:select': () => ({ data: null, error: { message: 'boom' } }) } }))
    expect((await renderInputsFor(db, board(), LOC)).status).toBe(503)
  })
})

describe('packForStage', () => {
  it('packNotInRecipeIs400', () => {
    expect(packForStage(board(), stage, 'welcome')).toMatchObject({ ok: false, status: 400, code: 'pack_not_for_stage' })
    expect(packForStage(board(), stage, 'trial_done')).toMatchObject({ ok: false, status: 400, code: 'pack_not_for_stage' })
    expect(packForStage(board(), stage, 'book_first_class').ok).toBe(true)
  })
})

describe('applyFollowupAction: install', () => {
  it('installUsesBoardRecipeAndRenderInputs', async () => {
    db = makeDb(responder())
    const res = await run()
    expect(res.ok).toBe(true)
    expect(installFollowupPack).toHaveBeenCalledTimes(1)
    expect(installFollowupPack.mock.calls[0][1]).toEqual({
      locationId: LOC,
      pipelineId: BOARD_ID,
      stage: { id: STAGE_ID, slug: 'o_reset_new' },
      recipeKey: 'paid_trial_offer',
      packKey: 'book_first_class',
      render: {
        studioName: 'UN1T Hatch Street',
        offerName: '14 Day Reset',
        durationDays: 14,
        signer: 'Alex Example',
        bookingFlowId: 'flow-123',
        appLinks: { iosUrl: 'https://apps.apple.com/x', androidUrl: 'https://play.google.com/y' },
      },
      createdBy: 'user-1',
      wantLive: true,
      version: 1,
    })
    expect(writes()).toEqual(['installFollowupPack:call'])
    const followupRead = db.log.find((e) => e.table === 'pipeline_stage_followups')
    expect(followupRead.filters).toEqual({ location_id: LOC, stage_id: STAGE_ID, pack_key: 'book_first_class' })
  })

  it('installTwiceReturnsSameRow', async () => {
    const row = liveRow({ version: 2 })
    db = makeDb(responder({ row }))
    installFollowupPack.mockResolvedValueOnce({ ok: true, followup: row, created: false })
    const res = await run()
    expect(res).toEqual({ ok: true, followup: row, created: false })
    expect(installFollowupPack.mock.calls[0][1].version).toBe(2)
    // Nothing touched: no sequence or row write of this file's own.
    expect(db.log.filter((e) => e.op !== 'select')).toEqual([])
  })

  it('installOverRejectedBumpsVersionAndDropsDraft', async () => {
    db = makeDb(responder({ row: liveRow({ state: 'rejected', version: 1 }), overrides: draftSequence }))
    const res = await run()
    expect(res.ok).toBe(true)
    expect(writes()).toEqual(['email_sequences:update', 'email_sequences:delete', 'installFollowupPack:call'])
    const del = db.log.find((e) => e.table === 'email_sequences' && e.op === 'delete')
    expect(del.filters).toEqual({ id: 's1', location_id: LOC, status: 'draft' })
    expect(installFollowupPack.mock.calls[0][1].version).toBe(2)
  })

  it('installOverRejectedWithAnActiveSequencePausesItFirst', async () => {
    db = makeDb(responder({ row: liveRow({ state: 'rejected', version: 1 }) }))
    const res = await run()
    expect(res.ok).toBe(true)
    expect(writes()).toEqual(['email_sequences:update', 'installFollowupPack:call'])
    const pause = db.log.find((e) => e.table === 'email_sequences' && e.op === 'update')
    expect(pause.values).toMatchObject({ status: 'paused' })
    expect(pause.filters).toEqual({ id: 's1', location_id: LOC, status: 'active' })
    expect(installFollowupPack.mock.calls[0][1].version).toBe(2)
  })

  it('installOverASpentRowRefusesAnUnknownSequenceStatus', async () => {
    db = makeDb(responder({
      row: liveRow({ state: 'off' }),
      overrides: {
        'email_sequences:update': () => ({ data: [], error: null }),
        'email_sequences:select': () => ({ data: { id: 's1', status: 'mystery' }, error: null }),
      },
    }))
    expect(await run()).toMatchObject({ ok: false, status: 409, code: 'sequence_changed' })
    expect(installFollowupPack).not.toHaveBeenCalled()
  })

  it('installOverADraftRowKeepsItsVersionAndDropsItsDraftSequence', async () => {
    db = makeDb(responder({ row: liveRow({ state: 'draft', version: 2 }), overrides: draftSequence }))
    await run()
    expect(writes()).toEqual(['email_sequences:update', 'email_sequences:delete', 'installFollowupPack:call'])
    expect(installFollowupPack.mock.calls[0][1].version).toBe(2)
  })

  it('installWithBodiesOnADraftRowIsAllowed', async () => {
    const bodies = { main: 'Hi {{1}}, see you at {studio}. {signer}' }
    db = makeDb(responder({ row: liveRow({ state: 'draft', version: 1 }), overrides: draftSequence }))
    expect((await run({ bodies })).ok).toBe(true)
    expect(installFollowupPack.mock.calls[0][1].bodies).toEqual(bodies)
  })

  it('installWithBodiesOnALiveOrAwaitingRowIs409UseReplace', async () => {
    const bodies = { main: 'Hi {{1}}, see you at {studio}. {signer}' }
    for (const state of ['live', 'awaiting_approval']) {
      installFollowupPack.mockClear()
      db = makeDb(responder({ row: liveRow({ state }) }))
      const res = await run({ bodies })
      expect(res).toEqual({
        ok: false, status: 409, code: 'use_replace',
        error: 'This follow-up is already set up. Use Change wording to send new wording.',
      })
      expect(installFollowupPack).not.toHaveBeenCalled()
      expect(writes()).toEqual([])
    }
  })

  it('installWithoutBodiesOnALiveRowStillPublishesNow', async () => {
    const row = liveRow({ state: 'awaiting_approval', version: 3 })
    db = makeDb(responder({ row }))
    installFollowupPack.mockResolvedValueOnce({ ok: true, followup: { ...row, state: 'live' }, created: false })
    const res = await run()
    expect(res).toMatchObject({ ok: true, followup: { state: 'live' }, created: false })
    expect(installFollowupPack.mock.calls[0][1].version).toBe(3)
    expect(installFollowupPack.mock.calls[0][1]).not.toHaveProperty('bodies')
    // No sequence or row write of this file's own (the mock call is not logged here).
    expect(writes()).toEqual([])
  })

  it('installOverOffBumpsVersion', async () => {
    db = makeDb(responder({ row: liveRow({ state: 'off', version: 3 }), overrides: draftSequence }))
    await run()
    expect(installFollowupPack.mock.calls[0][1].version).toBe(4)
  })

  it('aFailedDraftDeleteInstallsNothing', async () => {
    db = makeDb(responder({
      row: liveRow({ state: 'rejected' }),
      overrides: { ...draftSequence, 'email_sequences:delete': () => ({ data: null, error: { message: 'boom' } }) },
    }))
    const res = await run()
    expect(res).toMatchObject({ ok: false, status: 500 })
    expect(installFollowupPack).not.toHaveBeenCalled()
  })

  it('aLegacyBoardIs409', async () => {
    db = makeDb(responder())
    const res = await run({ board: board({ board_type: null }) })
    expect(res).toMatchObject({ ok: false, status: 409 })
    expect(db.log).toEqual([])
  })

  it('packNotForStageIs400BeforeAnyRead', async () => {
    db = makeDb(responder())
    const res = await run({ packKey: 'after_first_class' })
    expect(res).toMatchObject({ ok: false, status: 400, code: 'pack_not_for_stage' })
    expect(db.log).toEqual([])
  })
})

describe('applyFollowupAction: replace', () => {
  const bodies = { main: 'Hi {{1}}, your {offer} at {studio} is waiting. Reply here to book. {signer}' }

  it('replacePausesOldBeforeInstall', async () => {
    db = makeDb(responder({ row: liveRow({ version: 1 }) }))
    const res = await run({ action: 'replace', bodies })
    expect(res.ok).toBe(true)
    expect(writes()).toEqual(['email_sequences:update', 'pipeline_stage_followups:update', 'installFollowupPack:call'])
    const [pause, off] = db.log.filter((e) => e.op === 'update')
    expect(pause.values).toMatchObject({ status: 'paused' })
    expect(pause.values.updated_at).toEqual(expect.any(String))
    expect(pause.filters).toEqual({ id: 's1', location_id: LOC, status: 'active' })
    expect(pause.select).toBe('id')
    expect(off.values).toMatchObject({ state: 'off' })
    expect(off.filters).toEqual({ id: 'f1', location_id: LOC, state: 'live' })
    expect(off.select).toBe('id')
    const call = installFollowupPack.mock.calls[0][1]
    expect(call.version).toBe(2)
    expect(call.bodies).toEqual(bodies)
  })

  it('replaceStopsWhenPauseFails', async () => {
    db = makeDb(responder({
      row: liveRow(),
      overrides: { 'email_sequences:update': () => ({ data: null, error: { message: 'boom' } }) },
    }))
    const res = await run({ action: 'replace', bodies })
    expect(res).toMatchObject({ ok: false, status: 500 })
    expect(installFollowupPack).not.toHaveBeenCalled()
    expect(writes()).toEqual(['email_sequences:update'])
  })

  it('replaceRetriesTheSwitchOffWhenTheHookMovedTheRowToLive', async () => {
    // Read as awaiting_approval; the hook published the same sequence (which
    // we then paused) and claimed the row live before our switch-off.
    let followupReads = 0
    let offWrites = 0
    db = makeDb(responder({
      row: liveRow({ state: 'awaiting_approval' }),
      overrides: {
        'pipeline_stage_followups:select': () => {
          followupReads += 1
          return followupReads === 1 ? undefined : { data: liveRow({ state: 'live' }), error: null }
        },
        'pipeline_stage_followups:update': (e) => {
          offWrites += 1
          return e.filters.state === 'live' ? { data: [{ id: 'f1' }], error: null } : { data: [], error: null }
        },
      },
    }))
    const res = await run({ action: 'replace', bodies })
    expect(res.ok).toBe(true)
    expect(offWrites).toBe(2)
    expect(writes()).toEqual(['email_sequences:update', 'pipeline_stage_followups:update', 'pipeline_stage_followups:update', 'installFollowupPack:call'])
    const [firstOff, retryOff] = db.log.filter((e) => e.table === 'pipeline_stage_followups' && e.op === 'update')
    expect(firstOff.filters.state).toBe('awaiting_approval')
    expect(retryOff.filters).toEqual({ id: 'f1', location_id: LOC, state: 'live' })
  })

  it('replaceStopsWhenTheRowNowPointsAtAnotherSequence', async () => {
    let followupReads = 0
    db = makeDb(responder({
      row: liveRow(),
      overrides: {
        'pipeline_stage_followups:select': () => {
          followupReads += 1
          return followupReads === 1 ? undefined : { data: liveRow({ sequence_id: 's2' }), error: null }
        },
        'pipeline_stage_followups:update': () => ({ data: [], error: null }),
      },
    }))
    const res = await run({ action: 'replace', bodies })
    expect(res).toEqual({
      ok: false, status: 409, code: 'followup_changed',
      error: 'This follow-up changed while it was being switched off. Switch it off or change the wording again.',
    })
    expect(installFollowupPack).not.toHaveBeenCalled()
    // One attempt only: no retry against a row that moved on.
    expect(db.log.filter((e) => e.table === 'pipeline_stage_followups' && e.op === 'update')).toHaveLength(1)
  })

  it('aDraftSequenceIsDeletedNotPaused', async () => {
    db = makeDb(responder({
      row: liveRow({ state: 'awaiting_approval' }),
      overrides: {
        'email_sequences:update': () => ({ data: [], error: null }),
        'email_sequences:select': () => ({ data: { id: 's1', status: 'draft' }, error: null }),
      },
    }))
    const res = await run({ action: 'replace', bodies })
    expect(res.ok).toBe(true)
    expect(writes()).toEqual(['email_sequences:update', 'email_sequences:delete', 'pipeline_stage_followups:update', 'installFollowupPack:call'])
  })

  it('anAlreadyPausedSequenceIsFine', async () => {
    db = makeDb(responder({
      row: liveRow(),
      overrides: {
        'email_sequences:update': () => ({ data: [], error: null }),
        'email_sequences:select': () => ({ data: { id: 's1', status: 'paused' }, error: null }),
      },
    }))
    expect((await run({ action: 'replace', bodies })).ok).toBe(true)
    expect(installFollowupPack).toHaveBeenCalledTimes(1)
  })

  it('aSequenceThatWentActiveBetweenTheReadsStopsEverything', async () => {
    db = makeDb(responder({
      row: liveRow(),
      overrides: {
        'email_sequences:update': () => ({ data: [], error: null }),
        'email_sequences:select': () => ({ data: { id: 's1', status: 'active' }, error: null }),
      },
    }))
    const res = await run({ action: 'replace', bodies })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'sequence_changed' })
    expect(installFollowupPack).not.toHaveBeenCalled()
  })

  it('badWordingIs400AndTouchesNothing', async () => {
    db = makeDb(responder({ row: liveRow() }))
    const res = await run({ action: 'replace', bodies: { main: 'Hi {{2}}, come in.' } })
    expect(res).toMatchObject({ ok: false, status: 400 })
    expect(writes()).toEqual([])
    expect(installFollowupPack).not.toHaveBeenCalled()
  })

  it('replaceWithNoRowIs409', async () => {
    db = makeDb(responder())
    const res = await run({ action: 'replace', bodies })
    expect(res).toMatchObject({ ok: false, status: 409, code: 'no_followup' })
    expect(installFollowupPack).not.toHaveBeenCalled()
  })

  it('replaceArchivesTheOldSequenceAfterTheRowIsRepointed', async () => {
    db = makeDb(responder({ row: liveRow({ version: 1 }) }))
    installFollowupPack.mockImplementationOnce(async (_db, opts) => {
      db.log.push({ table: 'installFollowupPack', op: 'call', values: opts })
      return { ok: true, followup: { id: 'f1', state: 'awaiting_approval', version: opts.version, sequence_id: 's-new' }, created: true }
    })
    const res = await run({ action: 'replace', bodies })
    expect(res.ok).toBe(true)
    // Pause, off, install (re-points the row), THEN archive the old one.
    expect(writes()).toEqual(['email_sequences:update', 'pipeline_stage_followups:update', 'installFollowupPack:call', 'email_sequences:update'])
    const archive = db.log.at(-1)
    expect(archive.values).toMatchObject({ status: 'archived', updated_at: expect.any(String) })
    expect(archive.filters).toEqual({ id: 's1', location_id: LOC, status: ['paused', 'draft'] })
    expect(archive.select).toBe('id')
  })

  it('aFailedInstallLeavesTheOldSequenceUnarchived', async () => {
    db = makeDb(responder({ row: liveRow() }))
    installFollowupPack.mockResolvedValueOnce({ ok: false, status: 500, error: 'Could not submit the WhatsApp templates just now.' })
    await run({ action: 'replace', bodies })
    // The row still points at the old (paused) sequence, so it is still owned.
    expect(db.log.filter((e) => e.table === 'email_sequences' && e.op === 'update' && e.values?.status === 'archived')).toEqual([])
  })

  it('installOverAnOffRowArchivesTheOldSequenceOnceRepointed', async () => {
    db = makeDb(responder({
      row: liveRow({ state: 'off', version: 2 }),
      overrides: {
        'email_sequences:update': (e) => (e.values.status === 'paused' ? { data: [], error: null } : undefined),
        'email_sequences:select': () => ({ data: { id: 's1', status: 'paused' }, error: null }),
      },
    }))
    installFollowupPack.mockResolvedValueOnce({ ok: true, followup: { id: 'f1', state: 'awaiting_approval', version: 3, sequence_id: 's-new' }, created: true })
    expect((await run()).ok).toBe(true)
    const archive = db.log.filter((e) => e.table === 'email_sequences' && e.op === 'update').at(-1)
    expect(archive.values).toMatchObject({ status: 'archived' })
    expect(archive.filters.id).toBe('s1')
  })

  it('aFailedInstallAfterReplaceSaysTheFollowupIsOff', async () => {
    db = makeDb(responder({ row: liveRow() }))
    installFollowupPack.mockResolvedValueOnce({ ok: false, status: 500, error: 'Could not submit the WhatsApp templates just now.' })
    const res = await run({ action: 'replace', bodies })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/switched off until this installs/)
  })
})

describe('applyFollowupAction: off', () => {
  it('offPausesAndSwitchesOff', async () => {
    db = makeDb(responder({ row: liveRow() }))
    const res = await run({ action: 'off' })
    expect(res).toMatchObject({ ok: true, followup: { id: 'f1', state: 'off' } })
    // Pause, switch the row off, then retire the paused sequence (PIPEBUILD.5l).
    expect(writes()).toEqual(['email_sequences:update', 'pipeline_stage_followups:update', 'email_sequences:update'])
    const archive = db.log.filter((e) => e.table === 'email_sequences' && e.op === 'update').at(-1)
    expect(archive.values).toMatchObject({ status: 'archived' })
    expect(archive.filters).toEqual({ id: 's1', location_id: LOC, status: ['paused', 'draft'] })
    expect(installFollowupPack).not.toHaveBeenCalled()
  })

  it('aFailedArchiveOnOffIsLoggedAndTheActionStillSucceeds', async () => {
    let seqUpdates = 0
    db = makeDb(responder({
      row: liveRow(),
      overrides: {
        'email_sequences:update': () => {
          seqUpdates += 1
          return seqUpdates === 1 ? undefined : { data: null, error: { message: 'boom' } }
        },
      },
    }))
    const res = await run({ action: 'off' })
    expect(res).toMatchObject({ ok: true, followup: { state: 'off' } })
    expect(logError).toHaveBeenCalledWith('followup-owned-sequences', 'superseded follow-up sequence not archived', expect.objectContaining({ sequenceId: 's1' }))
  })

  it('offWithNoRowIs409', async () => {
    db = makeDb(responder())
    expect(await run({ action: 'off' })).toMatchObject({ ok: false, status: 409, code: 'no_followup' })
  })

  it('offOnAnOffRowIsUnchanged', async () => {
    const row = liveRow({ state: 'off' })
    db = makeDb(responder({ row }))
    expect(await run({ action: 'off' })).toEqual({ ok: true, followup: row, unchanged: true })
    expect(writes()).toEqual([])
  })

  it('offStopsWhenPauseFails', async () => {
    db = makeDb(responder({
      row: liveRow(),
      overrides: { 'email_sequences:update': () => ({ data: null, error: { message: 'boom' } }) },
    }))
    expect(await run({ action: 'off' })).toMatchObject({ ok: false, status: 500 })
    expect(writes()).toEqual(['email_sequences:update'])
  })
})
