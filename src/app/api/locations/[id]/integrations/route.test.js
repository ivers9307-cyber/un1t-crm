// N8NECHO.1 — PUT /api/locations/[id]/integrations (the n8n / API-key route).
//
// It used to `.update(...).select().single()` and return the WHOLE locations
// row: the Sensibo key, the ThinQ PAT, every settings credential and the
// customer agent's test phone numbers, to an API-key holder that had only
// just sent the two slices it writes. It now returns those two slices, with
// every secret-named key masked, under the old key paths. A failed read is a
// logged 500, never "Location not found". Fictional values only (public repo):
// every secret starts SYNTH-.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/api-auth', () => ({ authenticateApiKey: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))
vi.mock('@/lib/connection-registry', () => ({
  overlayConnections: vi.fn(async (_db, row) => row),
  syncConnectionFromLegacy: vi.fn(async () => ({ action: 'updated' })),
}))

import { PUT } from './route.js'
import { authenticateApiKey } from '@/lib/api-auth'
import { createServerClient } from '@/lib/supabase'
import { logError } from '@/lib/log'
import { syncConnectionFromLegacy } from '@/lib/connection-registry'
import { SECRET_MASK } from '@/lib/secret-keys'

const LOC = 'a0000000-0000-4000-8000-00000000000a'
const ORG = 'b0000000-0000-4000-8000-00000000000a'

const STORED_ROW = {
  id: LOC, name: 'Test Studio', slug: 'test-studio', organization_id: ORG,
  sensibo_api_key: 'SYNTH-SENSIBO', thinq_pat: 'SYNTH-THINQ', bca_config: { send_from: 'x@example.test' },
  settings: {
    glofox: { branch_id: 'b1', namespace: 'ns', api_key: 'SYNTH-GK', api_token: 'SYNTH-GT', webhook_secret: 'SYNTH-GW' },
    unifi: { host: 'https://u.example', api_token: 'SYNTH-UT' },
    customer_agent: { enabled: false, test_phones: ['+353000000000'] },
    webhooks: { lead_url: 'https://n8n.example/hook' },
  },
}

// A scripted double: the first locations call is the read, the second the
// write (update -> eq -> select -> single).
function mockDb({ readResult, writeResult }) {
  const calls = { updateArg: null, writeSelect: undefined }
  let n = 0
  const db = {
    from: vi.fn(() => {
      n += 1
      if (n === 1) {
        return { select: () => ({ eq: () => ({ single: async () => readResult }) }) }
      }
      return {
        update: (arg) => {
          calls.updateArg = arg
          return {
            eq: () => ({
              select: (cols) => {
                calls.writeSelect = cols
                return { single: async () => writeResult(arg) }
              },
            }),
          }
        },
      }
    }),
  }
  createServerClient.mockReturnValue(db)
  return calls
}

const put = (body) => PUT(
  new Request(`http://x/api/locations/${LOC}/integrations`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: LOC }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  authenticateApiKey.mockResolvedValue({ ok: true, orgId: null, legacy: true })
})

describe('PUT /api/locations/[id]/integrations: the echo (N8NECHO.1)', () => {
  it('echoes only glofox + webhooks, masked, under the old paths; no other column or slice', async () => {
    const calls = mockDb({
      readResult: { data: { settings: STORED_ROW.settings, organization_id: ORG }, error: null },
      writeResult: (arg) => ({ data: { id: LOC, name: 'Test Studio', slug: 'test-studio', settings: arg.settings }, error: null }),
    })
    const res = await put({ glofox: { ...STORED_ROW.settings.glofox, api_key: 'SYNTH-GK-NEW' } })
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.success).toBe(true)
    expect(body.data).toEqual({
      id: LOC, name: 'Test Studio', slug: 'test-studio',
      settings: {
        glofox: { branch_id: 'b1', namespace: 'ns', api_key: SECRET_MASK, api_token: SECRET_MASK, webhook_secret: SECRET_MASK },
        webhooks: { lead_url: 'https://n8n.example/hook' },
      },
    })
    expect(JSON.stringify(body)).not.toMatch(/SYNTH-|test_phones|sensibo|thinq|unifi|bca_config/)
    // The write names its columns: the whole row never leaves the database.
    expect(calls.writeSelect).toBe('id, name, slug, settings')
    // The write still merges into the stored settings (nothing else is dropped on disk).
    expect(calls.updateArg.settings.unifi).toEqual(STORED_ROW.settings.unifi)
    expect(calls.updateArg.settings.glofox.api_key).toBe('SYNTH-GK-NEW')
  })

  it('the registry re-sync still gets the RAW written row (it needs the real credentials)', async () => {
    mockDb({
      readResult: { data: { settings: STORED_ROW.settings, organization_id: ORG }, error: null },
      writeResult: (arg) => ({ data: { id: LOC, name: 'Test Studio', slug: 'test-studio', settings: arg.settings }, error: null }),
    })
    await put({ glofox: STORED_ROW.settings.glofox })
    const [, , platform, row] = syncConnectionFromLegacy.mock.calls[0]
    expect(platform).toBe('glofox')
    expect(row.settings.glofox.api_key).toBe('SYNTH-GK')
  })

  it('a slice that is absent echoes null', async () => {
    mockDb({
      readResult: { data: { settings: { customer_agent: { enabled: true } }, organization_id: ORG }, error: null },
      writeResult: (arg) => ({ data: { id: LOC, name: 'N', slug: 's', settings: arg.settings }, error: null }),
    })
    const body = await (await put({ webhooks: { lead_url: 'https://n8n.example/h2' } })).json()
    expect(body.data.settings).toEqual({ glofox: null, webhooks: { lead_url: 'https://n8n.example/h2' } })
  })
})

describe('PUT /api/locations/[id]/integrations: the masked echo sent back (N8NECHO.1)', () => {
  // The stored row carries a secret in BOTH slices, so the round-trip is
  // proved for each.
  const SETTINGS = {
    ...STORED_ROW.settings,
    webhooks: { lead_url: 'https://n8n.example/hook', signing_secret: 'SYNTH-WHS' },
  }
  const rowFrom = (arg) => ({ data: { id: LOC, name: 'Test Studio', slug: 'test-studio', settings: arg.settings }, error: null })

  it("PUT with the previous PUT's response body keeps the stored credentials, and the registry sync gets the real ones", async () => {
    mockDb({ readResult: { data: { settings: SETTINGS, organization_id: ORG }, error: null }, writeResult: rowFrom })
    const first = await (await put({ glofox: SETTINGS.glofox, webhooks: SETTINGS.webhooks })).json()
    expect(first.data.settings.glofox.api_key).toBe(SECRET_MASK)
    expect(first.data.settings.webhooks.signing_secret).toBe(SECRET_MASK)

    vi.clearAllMocks()
    const calls = mockDb({ readResult: { data: { settings: SETTINGS, organization_id: ORG }, error: null }, writeResult: rowFrom })
    const res = await put({ glofox: first.data.settings.glofox, webhooks: first.data.settings.webhooks })
    expect(res.status).toBe(200)

    expect(calls.updateArg.settings.glofox).toEqual(SETTINGS.glofox)
    expect(calls.updateArg.settings.webhooks).toEqual(SETTINGS.webhooks)
    expect(JSON.stringify(calls.updateArg)).not.toContain('••')
    const [, , platform, row] = syncConnectionFromLegacy.mock.calls[0]
    expect(platform).toBe('glofox')
    expect(row.settings.glofox).toMatchObject({ api_key: 'SYNTH-GK', api_token: 'SYNTH-GT', webhook_secret: 'SYNTH-GW' })
  })

  it('a masked key with nothing stored behind it is dropped, not written as the mask', async () => {
    const calls = mockDb({
      readResult: { data: { settings: { glofox: { branch_id: 'b1' } }, organization_id: ORG }, error: null },
      writeResult: rowFrom,
    })
    await put({ glofox: { branch_id: 'b1', api_key: SECRET_MASK } })
    expect(calls.updateArg.settings.glofox).toEqual({ branch_id: 'b1' })
  })

  it('a real new value is still written, and non-secret fields change as sent', async () => {
    const calls = mockDb({ readResult: { data: { settings: SETTINGS, organization_id: ORG }, error: null }, writeResult: rowFrom })
    await put({
      glofox: { ...SETTINGS.glofox, branch_id: 'b2', api_token: 'SYNTH-GT-NEW', api_key: SECRET_MASK },
      webhooks: { lead_url: 'https://n8n.example/h3', signing_secret: 'SYNTH-WHS-NEW' },
    })
    expect(calls.updateArg.settings.glofox).toEqual({ ...SETTINGS.glofox, branch_id: 'b2', api_token: 'SYNTH-GT-NEW' })
    expect(calls.updateArg.settings.webhooks).toEqual({ lead_url: 'https://n8n.example/h3', signing_secret: 'SYNTH-WHS-NEW' })
  })
})

describe('PUT /api/locations/[id]/integrations: the read (N8NECHO.1)', () => {
  it('a failed read is a logged 500 and writes nothing (it used to answer 404)', async () => {
    const calls = mockDb({
      readResult: { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } },
      writeResult: () => { throw new Error('must not write') },
    })
    const res = await put({ glofox: STORED_ROW.settings.glofox })
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
    expect(calls.updateArg).toBeNull()
    expect(logError).toHaveBeenCalledWith('locations/integrations', expect.any(String), expect.objectContaining({ locationId: LOC, code: '57014' }))
  })

  it('no row is still 404, and writes nothing', async () => {
    const calls = mockDb({
      readResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      writeResult: () => { throw new Error('must not write') },
    })
    const res = await put({ glofox: STORED_ROW.settings.glofox })
    expect(res.status).toBe(404)
    expect(calls.updateArg).toBeNull()
  })

  it("another org's key still gets 404 (APIKEYS.3 unchanged)", async () => {
    authenticateApiKey.mockResolvedValue({ ok: true, orgId: 'b0000000-0000-4000-8000-0000000000ff' })
    const calls = mockDb({
      readResult: { data: { settings: {}, organization_id: ORG }, error: null },
      writeResult: () => { throw new Error('must not write') },
    })
    const res = await put({ glofox: {} })
    expect(res.status).toBe(404)
    expect(calls.updateArg).toBeNull()
  })
})
