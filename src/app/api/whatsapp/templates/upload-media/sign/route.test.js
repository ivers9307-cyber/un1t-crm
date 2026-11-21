// ROUTEWRAP.R9 — POST /api/whatsapp/templates/upload-media/sign on withAuth.
// Fictional ids only: the repo is public.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', async (importOriginal) => ({ ...(await importOriginal()), getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', async (importOriginal) => ({ ...(await importOriginal()), createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/wa-template-access', () => ({ canUploadWaTemplateMediaAt: vi.fn(() => true) }))

import { POST } from './route.js'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { canUploadWaTemplateMediaAt } from '@/lib/wa-template-access'
import { LOC_A, LOC_B, person } from '../../../../../../../tests/helpers/owner-at-location-callers.js'

const IMAGE = { format: 'IMAGE', mime: 'image/png', size: 1000, file_name: 'header.png' }
const req = (body) => new Request('http://localhost/api/whatsapp/templates/upload-media/sign', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

let signed
beforeEach(() => {
  vi.clearAllMocks()
  canUploadWaTemplateMediaAt.mockReturnValue(true)
  getCurrentUser.mockResolvedValue(person({ [LOC_A]: 'manager' }, LOC_A))
  signed = vi.fn(async () => ({ data: { token: 'tok-synth' }, error: null }))
  createServerClient.mockReturnValue({ storage: { from: vi.fn(() => ({ createSignedUploadUrl: signed })) } })
})

describe('POST /api/whatsapp/templates/upload-media/sign', () => {
  it("signed out: withAuth's 401 (was 'Unauthorised')", async () => {
    getCurrentUser.mockResolvedValue(null)
    const res = await POST(req(IMAGE))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' })
    expect(signed).not.toHaveBeenCalled()
  })

  it('a studio the caller is not at: 403 Forbidden, nothing minted', async () => {
    const res = await POST(req({ ...IMAGE, location_id: LOC_B }))
    expect(res.status).toBe(403)
    expect(signed).not.toHaveBeenCalled()
  })

  it('no upload right at the studio: 403', async () => {
    canUploadWaTemplateMediaAt.mockReturnValue(false)
    expect((await POST(req(IMAGE))).status).toBe(403)
    expect(canUploadWaTemplateMediaAt).toHaveBeenCalledWith(expect.anything(), LOC_A)
  })

  it('mints a path in the studio folder', async () => {
    const res = await POST(req(IMAGE))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.path.startsWith(`${LOC_A}/`)).toBe(true)
    expect(body.token).toBe('tok-synth')
  })

  it('a storage failure answers a fixed line, the storage text logged', async () => {
    signed.mockResolvedValue({ data: null, error: { message: 'bucket secret text' } })
    const res = await POST(req(IMAGE))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('Could not create upload URL. Try again.')
    expect(JSON.stringify(body)).not.toContain('bucket secret text')
    expect(logError).toHaveBeenCalled()
  })
})
