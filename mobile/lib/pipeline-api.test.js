// WAITLIST-M.1 — a manual-board stage move from the phone.
//
// Two things this file exists to pin, and the second is the important one:
//
//   1. The move goes to POST /api/deals/[id]/stage, through api() (Bearer JWT).
//      A direct `deals.stage_id` write via the supabase client would be one
//      line shorter and would skip ALL FIVE of the things that route does: the
//      `pipeline` permission check, the in-location guard, the same-BOARD stage
//      validation (Hatch can run two boards at one location, so a location
//      filter alone would let a waitlist card be parked in a gym column), the
//      STAGETRIG.1 sequence trigger, and the pipeline.manual_move audit row
//      that makes "who moved this card?" answerable. The same reasoning already
//      routes setPipelineCold and createNote through /api/*; this test asserts
//      it rather than trusting the comment. Hence the explicit "supabase was
//      never touched" assertion below.
//
//   2. A refusal is RETURNED, not swallowed. The route answers 400
//      `pipeline_is_derived` for a derived board and 400
//      `unknown_stage_for_pipeline` for a stage on another board; the screen
//      can only leave the card where it was, and say so, if the envelope
//      reaches it intact.
//
// `./api` and `./supabase` are mocked BEFORE import — they pull the
// React-Native runtime, which must never load under vitest's Node environment
// (see vitest.config.js).

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({ api: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { from: vi.fn() } }))

import { api } from './api'
import { supabase } from './supabase'
import { moveDealToStage } from './pipeline-api'

const DEAL = '11111111-1111-1111-1111-111111111111'
const STAGE = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  api.mockResolvedValue({ success: true, data: { moved: true, stage_id: STAGE } })
})

describe('moveDealToStage — the write goes through the guarded route', () => {
  it('POSTs the stage id to /api/deals/[id]/stage', async () => {
    const res = await moveDealToStage(DEAL, STAGE)
    expect(api).toHaveBeenCalledTimes(1)
    expect(api).toHaveBeenCalledWith(`/api/deals/${DEAL}/stage`, {
      method: 'POST',
      body: { stage_id: STAGE },
    })
    expect(res).toEqual({ success: true, data: { moved: true, stage_id: STAGE } })
  })

  it('never writes deals.stage_id through the supabase client', async () => {
    await moveDealToStage(DEAL, STAGE)
    // A direct update would skip the permission check, the location guard, the
    // same-board validation, the sequence trigger AND the audit row.
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('moveDealToStage — a refusal must reach the caller', () => {
  it('surfaces the derived-board refusal instead of swallowing it', async () => {
    api.mockResolvedValue({ success: false, error: 'pipeline_is_derived', status: 400 })
    const res = await moveDealToStage(DEAL, STAGE)
    expect(res.success).toBe(false)
    expect(res.error).toBe('pipeline_is_derived')
  })

  it('surfaces a stage that belongs to another board', async () => {
    api.mockResolvedValue({ success: false, error: 'unknown_stage_for_pipeline', status: 400 })
    expect(await moveDealToStage(DEAL, STAGE)).toMatchObject({
      success: false,
      error: 'unknown_stage_for_pipeline',
    })
  })

  it('surfaces a transport envelope untouched, so a dropped call is not read as a move', async () => {
    api.mockResolvedValue({ success: false, transport: true, error: 'Network error: failed' })
    const res = await moveDealToStage(DEAL, STAGE)
    expect(res.success).toBe(false)
    expect(res.transport).toBe(true)
  })
})

describe('moveDealToStage — missing ids', () => {
  it('answers an envelope rather than POSTing to /api/deals/undefined/stage', async () => {
    const res = await moveDealToStage(null, STAGE)
    expect(res.success).toBe(false)
    expect(typeof res.error).toBe('string')
    expect(api).not.toHaveBeenCalled()
  })

  it('does the same when the stage id is missing', async () => {
    const res = await moveDealToStage(DEAL, null)
    expect(res.success).toBe(false)
    expect(api).not.toHaveBeenCalled()
  })
})
