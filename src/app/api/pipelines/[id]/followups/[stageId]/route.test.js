import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual('@/lib/auth')
  return { ...actual, getCurrentUser: vi.fn() }
})
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/pipeline-boards', () => ({ boardLocationId: vi.fn(), getBoard: vi.fn() }))
vi.mock('@/lib/sequence-access', () => ({ canBuildSequencesAt: vi.fn() }))
vi.mock('@/lib/wa-template-access', () => ({ canManageWaTemplatesAt: vi.fn() }))
vi.mock('@/lib/pipeline-board-followups', async () => {
  const actual = await vi.importActual('@/lib/pipeline-board-followups')
  return { ...actual, applyFollowupAction: vi.fn() }
})

import { PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { boardLocationId, getBoard } from '@/lib/pipeline-boards'
import { canBuildSequencesAt } from '@/lib/sequence-access'
import { canManageWaTemplatesAt } from '@/lib/wa-template-access'
import { applyFollowupAction } from '@/lib/pipeline-board-followups'

const LOC = 'a0000000-0000-4000-8000-000000000001'
const BOARD = 'b0000000-0000-4000-8000-000000000001'
const STAGE = 'c0000000-0000-4000-8000-000000000001'
const props = { params: Promise.resolve({ id: BOARD, stageId: STAGE }) }
const userWith = (role, locs = [LOC]) => ({
  id: 'u1', role, profileRole: 'staff', isMaster: false,
  activeLocation: { id: locs[0] }, locations: locs.map((id) => ({ id })),
  rolesByLocation: Object.fromEntries(locs.map((id) => [id, role])),
})
const req = (b) => new Request(`http://x/api/pipelines/${BOARD}/followups/${STAGE}`, { method: 'PUT', body: JSON.stringify(b) })
const theBoard = (over = {}) => ({
  id: BOARD, key: 'o_reset', name: 'Reset', board_type: 'offer', recipe_key: 'paid_trial_offer',
  config: { duration_days: 14 },
  stages: [{ id: STAGE, slug: 'o_reset_new', name: 'New Leads', stage_role: 'new' }],
  followups: [],
  ...over,
})
const body = { action: 'replace', pack_key: 'book_first_class', bodies: { main: 'Hi {{1}}, see you at {studio}. {signer}' } }

beforeEach(() => {
  vi.clearAllMocks()
  canBuildSequencesAt.mockReturnValue(false)
  canManageWaTemplatesAt.mockReturnValue(false)
  boardLocationId.mockResolvedValue({ ok: true, locationId: LOC })
  getBoard.mockResolvedValue({ ok: true, board: theBoard() })
  applyFollowupAction.mockResolvedValue({ ok: true, followup: { id: 'f1', state: 'awaiting_approval' }, created: true })
})

describe('PUT /api/pipelines/[id]/followups/[stageId]', () => {
  it('managerWithWhatsappCanReplace', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    canBuildSequencesAt.mockReturnValue(true)
    canManageWaTemplatesAt.mockReturnValue(true)
    getBoard.mockResolvedValue({ ok: true, board: theBoard({ followups: [{ id: 'f0', stage_id: STAGE, pack_key: 'book_first_class', state: 'live' }] }) })
    const res = await PUT(req(body), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { followup: { id: 'f1', state: 'awaiting_approval' }, created: true } })
    const args = applyFollowupAction.mock.calls[0][1]
    expect(args).toMatchObject({ action: 'replace', packKey: 'book_first_class', bodies: body.bodies, locationId: LOC })
    expect(args.stage).toMatchObject({ id: STAGE, stage_role: 'new' })
    expect(canBuildSequencesAt).toHaveBeenCalledWith(expect.anything(), LOC)
    expect(canManageWaTemplatesAt).toHaveBeenCalledWith(expect.anything(), LOC)
  })

  it('managerWithoutTemplatePermissionIs403', async () => {
    getCurrentUser.mockResolvedValue(userWith('manager'))
    canBuildSequencesAt.mockReturnValue(true)
    const res = await PUT(req(body), props)
    expect(res.status).toBe(403)
    expect(getBoard).not.toHaveBeenCalled()
    expect(applyFollowupAction).not.toHaveBeenCalled()
  })

  it('ownerCanActWithoutTheTwoPermissions', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await PUT(req({ action: 'off', pack_key: 'book_first_class' }), props)
    expect(res.status).toBe(200)
  })

  describe('owner-only install and switch off (RAILS.1)', () => {
    const OWNER_ONLY = 'Only an owner can install or switch off a follow-up. You can change the wording of one that is already set up.'
    const row = (state) => ({ id: 'f1', stage_id: STAGE, pack_key: 'book_first_class', state })
    const install = { action: 'install', pack_key: 'book_first_class', bodies: body.bodies }
    const off = { action: 'off', pack_key: 'book_first_class' }
    const asManager = () => {
      getCurrentUser.mockResolvedValue(userWith('manager'))
      canBuildSequencesAt.mockReturnValue(true)
      canManageWaTemplatesAt.mockReturnValue(true)
    }
    const cases = [
      ['replace on a live row', body, [row('live')]],
      ['install with bodies on a draft row', install, [row('draft')]],
      ['install on a stage with no row', install, []],
      ['install on a rejected row', install, [row('rejected')]],
      ['install on an off row', install, [row('off')]],
      ['off on a live row', off, [row('live')]],
      ['replace on an off row', body, [row('off')]],
      ['replace on a rejected row', body, [row('rejected')]],
      ['replace on a stage with no row', body, []],
    ]
    const managerAllowed = new Set(['replace on a live row', 'install with bodies on a draft row'])

    for (const [name, b, followups] of cases) {
      it(`manager: ${name}`, async () => {
        asManager()
        getBoard.mockResolvedValue({ ok: true, board: theBoard({ followups }) })
        const res = await PUT(req(b), props)
        if (managerAllowed.has(name)) {
          expect(res.status).toBe(200)
          expect(applyFollowupAction).toHaveBeenCalledTimes(1)
        } else {
          expect(res.status).toBe(403)
          expect(await res.json()).toEqual({ success: false, error: OWNER_ONLY, code: 'owner_only' })
          expect(applyFollowupAction).not.toHaveBeenCalled()
        }
      })

      it(`owner: ${name}`, async () => {
        getCurrentUser.mockResolvedValue(userWith('owner'))
        getBoard.mockResolvedValue({ ok: true, board: theBoard({ followups }) })
        const res = await PUT(req(b), props)
        expect(res.status).toBe(200)
        expect(applyFollowupAction).toHaveBeenCalledTimes(1)
      })
    }

    it('another pack on the same stage does not count as the row', async () => {
      asManager()
      getBoard.mockResolvedValue({ ok: true, board: theBoard({ followups: [{ ...row('draft'), pack_key: 'other_pack' }] }) })
      const res = await PUT(req(install), props)
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe('owner_only')
    })
  })

  it('packNotInRecipeIs400', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await PUT(req({ action: 'install', pack_key: 'welcome' }), props)
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('pack_not_for_stage')
    expect(applyFollowupAction).not.toHaveBeenCalled()
  })

  it('packForAnotherStageRoleIs400', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await PUT(req({ action: 'install', pack_key: 'trial_done' }), props)
    expect(res.status).toBe(400)
  })

  it('legacyBoardIs409', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    getBoard.mockResolvedValue({ ok: true, board: theBoard({ board_type: null, recipe_key: null }) })
    const res = await PUT(req(body), props)
    expect(res.status).toBe(409)
    expect(applyFollowupAction).not.toHaveBeenCalled()
  })

  it('otherStudioBoardIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner', ['other']))
    const res = await PUT(req(body), props)
    expect(res.status).toBe(404)
    expect(getBoard).not.toHaveBeenCalled()
  })

  it('stageNotOnBoardIs404', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    getBoard.mockResolvedValue({ ok: true, board: theBoard({ stages: [] }) })
    expect((await PUT(req(body), props)).status).toBe(404)
  })

  it('badIdsAre404WithoutARead', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    const res = await PUT(req(body), { params: Promise.resolve({ id: BOARD, stageId: 'nope' }) })
    expect(res.status).toBe(404)
    expect(boardLocationId).not.toHaveBeenCalled()
  })

  it('badActionIs400', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    expect((await PUT(req({ action: 'delete', pack_key: 'book_first_class' }), props)).status).toBe(400)
  })

  it('libRefusalPassesThroughWithItsCode', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    applyFollowupAction.mockResolvedValue({ ok: false, status: 409, error: 'changed', code: 'followup_changed' })
    const res = await PUT(req(body), props)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'changed', code: 'followup_changed' })
  })

  it('publishErrorIsReported', async () => {
    getCurrentUser.mockResolvedValue(userWith('owner'))
    applyFollowupAction.mockResolvedValue({ ok: true, followup: { id: 'f1' }, created: false, publishError: 'nope' })
    const res = await PUT(req(body), props)
    expect((await res.json()).data).toEqual({ followup: { id: 'f1' }, created: false, publish_error: 'nope' })
  })
})
