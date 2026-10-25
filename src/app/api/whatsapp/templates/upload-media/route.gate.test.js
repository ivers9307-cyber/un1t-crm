// C138 (a) — the template-media upload routes (sign, then finalise) judged
// membership only: any staff member at a studio could mint a slot in the PUBLIC
// 'whatsapp-templates' bucket and push media to Meta on the studio's number.
// They now take the template routes' rule at the studio uploaded for
// (canManageWaTemplatesAt: MANAGER_ROLES + `whatsapp` there, WEB-3), or
// master / owner there (the card-set editor's rule: its card-image upload
// rides these same two routes and PUT /api/whatsapp/card-sets is
// master-or-owner). No studio at all fails closed. The refusal comes before
// storage or Meta is touched. Fictional ids.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/whatsapp', () => ({ uploadMediaForTemplate: vi.fn(async () => 'h:synth') }))
vi.mock('@/lib/whatsapp-config', () => ({ getLocationWhatsAppNumberConfig: vi.fn(async () => null) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

import { POST as SIGN } from './sign/route.js'
import { POST as FINALISE } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { person, MASTER, LOC_A, LOC_B } from '../../../../../../tests/helpers/role-sweep-callers.js'

const PATH_B = `${LOC_B}/c0000000-0000-4000-8000-00000000000c.jpg`
let storageCalls
function makeDb() {
  return {
    storage: {
      from: () => ({
        createSignedUploadUrl: async (p) => { storageCalls.push(['sign', p]); return { data: { token: 'tok' }, error: null } },
        download: async (p) => { storageCalls.push(['download', p]); return { data: new Blob([new Uint8Array([0xff, 0xd8, 0xff])]), error: null } },
        getPublicUrl: () => ({ data: { publicUrl: 'https://storage.test/x.jpg' } }),
        remove: () => Promise.resolve({ error: null }),
      }),
    },
  }
}

const sign = (body) => SIGN(new Request('https://crm.test/api/whatsapp/templates/upload-media/sign', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ format: 'IMAGE', mime: 'image/jpeg', size: 1000, file_name: 'x.jpg', ...body }),
}))
const finalise = (body) => FINALISE(new Request('https://crm.test/api/whatsapp/templates/upload-media', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ path: PATH_B, format: 'IMAGE', mime: 'image/jpeg', file_name: 'x.jpg', ...body }),
}))

const at = (loc, role, whatsapp, active = loc) => person({ [loc]: { role, permissions: { whatsapp } } }, active)

beforeEach(() => {
  vi.clearAllMocks()
  storageCalls = []
  createServerClient.mockReturnValue(makeDb())
})

const allowed = [
  ['a manager with whatsapp there', at(LOC_B, 'manager', true)],
  ['a head coach with whatsapp there', at(LOC_B, 'head_coach', true)],
  ['an owner there, whatsapp switched off (card-set editor rule)', at(LOC_B, 'owner', false)],
  ['manager at the target while a studio where they are staff is active',
    person({ [LOC_A]: { role: 'staff', permissions: { whatsapp: true } }, [LOC_B]: { role: 'manager', permissions: { whatsapp: true } } }, LOC_A)],
  ['a master', MASTER],
]
const refused = [
  ['plain staff with whatsapp there (main: allowed)', at(LOC_B, 'staff', true)],
  ['a manager with whatsapp switched off there', at(LOC_B, 'manager', false)],
  ['manager at the ACTIVE studio, staff at the target',
    person({ [LOC_A]: { role: 'manager', permissions: { whatsapp: true } }, [LOC_B]: { role: 'staff', permissions: { whatsapp: true } } }, LOC_A)],
]

describe('POST upload-media/sign — the template rule at the studio (C138 a)', () => {
  it.each(allowed)('%s: a slot is minted', async (_l, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await sign({ location_id: LOC_B })
    expect(res.status).toBe(200)
    expect(storageCalls).toHaveLength(1)
    expect(storageCalls[0][1].startsWith(`${LOC_B}/`)).toBe(true)
  })

  it.each(refused)('%s: 403, no slot', async (_l, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await sign({ location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(storageCalls).toEqual([])
  })

  it('no studio at all (no body location, no active studio) fails closed: no global/ slot', async () => {
    getCurrentUser.mockResolvedValue({ ...at(LOC_B, 'manager', true), activeLocation: null })
    const res = await sign({})
    expect(res.status).toBe(403)
    expect(storageCalls).toEqual([])
  })

  it('not a member of the studio: 403 as before', async () => {
    getCurrentUser.mockResolvedValue(at(LOC_A, 'owner', true))
    const res = await sign({ location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(storageCalls).toEqual([])
  })
})

describe('POST upload-media (finalise) — the same rule, before storage or Meta (C138 a)', () => {
  it.each(allowed)('%s: finalised', async (_l, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await finalise({ location_id: LOC_B })
    expect(res.status).toBe(200)
    expect(storageCalls).toEqual([['download', PATH_B]])
  })

  it.each(refused)('%s: 403, nothing downloaded or pushed', async (_l, caller) => {
    getCurrentUser.mockResolvedValue(caller)
    const res = await finalise({ location_id: LOC_B })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: 'Forbidden' })
    expect(storageCalls).toEqual([])
  })

  it('no studio at all fails closed (a global/ path is never finalised)', async () => {
    getCurrentUser.mockResolvedValue({ ...at(LOC_B, 'manager', true), activeLocation: null })
    const res = await finalise({ path: 'global/c0000000-0000-4000-8000-00000000000c.jpg' })
    expect(res.status).toBe(403)
    expect(storageCalls).toEqual([])
  })
})
