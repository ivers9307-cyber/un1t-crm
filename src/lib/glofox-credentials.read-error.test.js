// src/lib/glofox-credentials.read-error.test.js
// REGISTRYREAD.1a — glofoxCredentialsForLocation keeps its all-null shape on
// a failed settings read (so every unmigrated caller behaves exactly as
// before) but ADDS readError and logs it; the webhook's branch lookup tells
// "no such branch" from "could not look".
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/connection-registry', () => ({
  readGlofoxConfig: vi.fn(),
  findGlofoxConfigByBranchId: vi.fn(),
}))
vi.mock('@/lib/log', async (importOriginal) => ({ ...(await importOriginal()), logError: vi.fn() }))

import { readGlofoxConfig, findGlofoxConfigByBranchId } from '@/lib/connection-registry'
import { logError } from '@/lib/log'
import {
  glofoxCredentialsForLocation,
  readGlofoxCredentialsByBranchId,
  missingGlofoxCredentialsForLocation,
} from './glofox.js'
import { GLOFOX_SETTINGS_UNREADABLE } from './glofox-settings-read.js'

const BOOM = { message: 'boom' }
const CFG = {
  branch_id: 'b123', api_key: 'k', api_token: 't', webhook_secret: 'wh', namespace: 'ns',
  trainer_names: { A: 'Coach A' }, hidden_class_keywords: ['el1tes'],
}

beforeEach(() => vi.clearAllMocks())

describe('glofoxCredentialsForLocation', () => {
  it('a failed settings read: all-null credentials PLUS readError, logged once', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: {}, error: BOOM })
    const creds = await glofoxCredentialsForLocation({}, 'loc-1')
    expect(creds.readError).toBe(GLOFOX_SETTINGS_UNREADABLE)
    expect(creds).toMatchObject({ branchId: null, apiKey: null, apiToken: null, webhookSecret: null })
    // Unmigrated callers still read it the way they always did.
    expect(missingGlofoxCredentialsForLocation(creds)).toEqual(['Branch ID', 'API Key', 'API Token'])
    expect(logError).toHaveBeenCalledOnce()
    expect(logError.mock.calls[0][0]).toBe('glofox')
  })

  it('a genuinely unconfigured studio: all null, readError null, nothing logged', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: {}, error: null })
    const creds = await glofoxCredentialsForLocation({}, 'loc-1')
    expect(creds.readError).toBeNull()
    expect(creds.branchId).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  it('a configured studio: the credentials, the deny-list, readError null', async () => {
    readGlofoxConfig.mockResolvedValueOnce({ cfg: CFG, error: null })
    const creds = await glofoxCredentialsForLocation({}, 'loc-1')
    expect(creds).toEqual({
      branchId: 'b123', apiKey: 'k', apiToken: 't', namespace: 'ns',
      trainerNames: { A: 'Coach A' }, hiddenClassKeywords: ['el1tes'],
      webhookSecret: 'wh', readError: null,
    })
  })
})

// A locations double for the legacy containment query: .select().filter().limit() awaited.
function legacyDb(answer) {
  const b = { select: () => b, filter: () => b, limit: () => (answer === 'throw' ? Promise.reject(new Error('down')) : Promise.resolve(answer)) }
  return { from: () => b }
}

describe('readGlofoxCredentialsByBranchId', () => {
  it('a registry hit answers straight away', async () => {
    findGlofoxConfigByBranchId.mockResolvedValueOnce({ locationId: 'loc-1', cfg: CFG })
    const out = await readGlofoxCredentialsByBranchId(legacyDb('throw'), 'b123')
    expect(out.error).toBeNull()
    expect(out.creds).toMatchObject({ locationId: 'loc-1', webhookSecret: 'wh' })
  })
  it('registry miss + the legacy query FAILS → { creds: null, error } (never "unknown branch")', async () => {
    findGlofoxConfigByBranchId.mockResolvedValueOnce(null)
    const out = await readGlofoxCredentialsByBranchId(legacyDb({ data: null, error: BOOM }), 'b123')
    expect(out).toEqual({ creds: null, error: BOOM })
  })
  it('registry miss + the legacy query THROWS → an error too', async () => {
    findGlofoxConfigByBranchId.mockResolvedValueOnce(null)
    const out = await readGlofoxCredentialsByBranchId(legacyDb('throw'), 'b123')
    expect(out.creds).toBeNull()
    expect(out.error).toBeInstanceOf(Error)
  })
  it('no location has the branch → { creds: null, error: null } (a real answer)', async () => {
    findGlofoxConfigByBranchId.mockResolvedValueOnce(null)
    expect(await readGlofoxCredentialsByBranchId(legacyDb({ data: [], error: null }), 'b123'))
      .toEqual({ creds: null, error: null })
  })
  it('a legacy row answers with its credentials', async () => {
    findGlofoxConfigByBranchId.mockResolvedValueOnce(null)
    const out = await readGlofoxCredentialsByBranchId(legacyDb({ data: [{ id: 'loc-2', settings: { glofox: CFG } }], error: null }), 'b123')
    expect(out).toEqual({ creds: { locationId: 'loc-2', branchId: 'b123', apiKey: 'k', apiToken: 't', webhookSecret: 'wh' }, error: null })
  })
})
